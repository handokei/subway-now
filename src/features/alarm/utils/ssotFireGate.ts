/**
 * #1572 (T9, ADR-017) — Device fire path SSoT 게이트.
 *
 * 배경
 * ====
 * ADR-017 원칙 1~4는 backend SSoT가 alarm 결정의 단일 권위라고 명시했으나, device fg/bg fire path
 * 5개가 각자 fire 결정을 내려 같은 alarmId/stationId가 중복 발사되는 X1/X2/X6 회귀가 있었다
 * (2026-06-20 용마산 station-passed 12:30:14 + 12:32:24 중복 발사 evidence — 사용자는 11분 정지였음).
 *
 * 본 helper는 5 fire path가 reader-only 호출하는 단일 게이트 진입점. backend가 silent push payload
 * `ssot.alarmEvents` / `ssot.passedStations`로 forward한 결정을 device가 mirror에 영속화하면, 본
 * 함수가 mirror에서 read해 차단 여부를 반환한다 (mutate X).
 *
 * 두 게이트
 * ========
 *   - Gate A `gate-alarm-already-decided`: mirror.alarmEvents에 이미 같은 alarmId가 있으면 block.
 *     같은 alarm 결정 중복 발사 차단(X2).
 *   - Gate B `gate-station-already-passed`: mirror.passedStations 또는 mirror.alarmEvents에
 *     같은 stationId가 station-passed/imminent로 이미 있으면 block. 이미 지나간 station에 늦은
 *     fire 차단(X1/X6).
 *
 * Graceful 정책
 * =============
 *   - mirror 자체 부재(처음 trip / 머지 직후) → `mirror-missing` no-block. 기존 fire path 동작 유지.
 *   - mirror staleness(>180s) → `mirror-stale` no-block. T10 Sticky SSoT가 stale 시 별도 차단 정책
 *     (BACKEND_SSOT_STALE_BLOCK_*)으로 alarm 차단. 본 게이트는 freshness 판정만 graceful skip.
 *   - 게이트가 block 시 caller가 `appendAlarmLog`로 reason stamp + fire path return (silence).
 *
 * 5 fire path wire 위치
 * =====================
 * | Path | 파일 / 줄                          | reason 라벨        |
 * |------|-----------------------------------|-------------------|
 * | A    | useStationAlarm.ts:947-955         | source='fg'        |
 * | B    | useStationAlarm.ts:1093-1094       | source='fg-arvlcd' |
 * | C    | useStationAlarm.ts:1153            | source='fg'        |
 * | D    | useStationAlarm.ts:585             | source='fg'        |
 * | E    | silentPushTask.ts:1158             | source='silent-push-skipped' |
 *
 * #1582 Wire-completion 5단
 * =========================
 *   1. Orphan: evaluateSsotFireGate는 5 path에서 호출됨 (`lint:orphan` pass).
 *   2. Dashboard: alarmLog reason 'gate-alarm-already-decided' / 'gate-station-already-passed' →
 *      DebugModal Counters section + Sentry breadcrumb로 가시.
 *   3. 의존 PR: T8 #1561 (payload.ssot wire) + T8b #1568 (mirror persist) 머지됨.
 *   4. 측정 plan: 1주 production trip 측정 — block 카운트 + 실제 중복 fire 0건 검증.
 *   5. Device verify: 실기기 trip에서 station-passed 중복 회귀 0건 검증 필수.
 */

import { readBackendSsotMirror } from './backendSsotMirror';

/**
 * mirror staleness 임계 — backend가 silent push로 mirror를 갱신해야 하는 정상 주기는 ~30s.
 * 180s = 6 polling cycle 누락 = backend 정지/cron failure 정황 → 게이트는 graceful skip.
 *
 * T10 (#1573)이 더 긴 임계(5min/30min)로 별도 alarm/notify 차단을 적용하므로 본 임계는 그 아래.
 */
export const SSOT_FIRE_GATE_STALENESS_MS = 180_000;

/**
 * 게이트 결정 사유.
 *
 *   - block: gate-alarm-already-decided | gate-station-already-passed
 *   - no-block: mirror-missing | mirror-stale | no-match
 */
export type SsotFireGateReason =
  | 'gate-alarm-already-decided'
  | 'gate-station-already-passed'
  | 'mirror-missing'
  | 'mirror-stale'
  | 'no-match';

export interface SsotFireGateInput {
  /** 발사 후보 alarmId — backend가 forward한 alarmEvents.alarmId와 비교 (Gate A). */
  alarmId: string;
  /** 발사 후보 stationId — backend가 forward한 passedStations / alarmEvents.stationId와 비교 (Gate B). */
  stationId: string;
  /** alarm 카테고리. station-passed/imminent만 Gate B 적용(다른 카테고리는 다른 logic). */
  type?: 'station-passed' | 'transfer' | 'destination' | 'imminent';
  /** 현재 시각 epoch ms. caller가 명시 시 (테스트), 미명시 시 Date.now(). */
  now?: number;
}

export interface SsotFireGateOutcome {
  blocked: boolean;
  reason: SsotFireGateReason;
}

/**
 * 5 fire path가 호출하는 단일 진입점. mirror를 read해 게이트 A/B 평가 후 결과 반환.
 *
 * mirror read 실패(AsyncStorage error 등)는 readBackendSsotMirror가 null 반환 → mirror-missing
 * graceful no-block. backend가 mirror를 보내기 전까지는 본 게이트가 false-positive 차단을 만들지 않는다.
 */
export async function evaluateSsotFireGate(
  input: SsotFireGateInput,
): Promise<SsotFireGateOutcome> {
  const mirror = await readBackendSsotMirror();
  if (mirror === null) {
    return { blocked: false, reason: 'mirror-missing' };
  }
  const now = input.now ?? Date.now();
  if (now - mirror.receivedAt > SSOT_FIRE_GATE_STALENESS_MS) {
    return { blocked: false, reason: 'mirror-stale' };
  }
  // Gate A — alarmId 매칭. backend가 결정한 alarm을 device가 재발사하려는 시도 차단.
  if (mirror.alarmEvents) {
    for (const e of mirror.alarmEvents) {
      if (e.alarmId === input.alarmId) {
        return { blocked: true, reason: 'gate-alarm-already-decided' };
      }
    }
  }
  // Gate B — station-passed/imminent 카테고리만 적용. mirror.passedStations + alarmEvents 양쪽에서
  // stationId 매칭 시 차단. transfer/destination은 별도 logic(여러 hop을 cover하므로 단순 station
  // 매칭은 false positive 위험).
  const applyStationGate = input.type === 'station-passed' || input.type === 'imminent';
  if (applyStationGate) {
    if (mirror.passedStations.includes(input.stationId)) {
      return { blocked: true, reason: 'gate-station-already-passed' };
    }
    if (mirror.alarmEvents) {
      for (const e of mirror.alarmEvents) {
        if (
          e.stationId === input.stationId &&
          (e.type === 'station-passed' || e.type === 'imminent')
        ) {
          return { blocked: true, reason: 'gate-station-already-passed' };
        }
      }
    }
  }
  return { blocked: false, reason: 'no-match' };
}
