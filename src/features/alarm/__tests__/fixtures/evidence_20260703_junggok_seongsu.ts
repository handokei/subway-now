/**
 * 2026-07-03 08:24 KST 중곡→성수 trip evidence fixture — device side (Issue #2024).
 *
 * Backend fixture(`backend/alarm-worker/src/__tests__/fixtures/evidence_20260703_junggok_seongsu.ts`)와
 * 자매 파일이다. Device 는 backend 가 발사한 silent push 를 받아 처리하는 쪽 시나리오를 담는다.
 *
 * 정합 근거:
 * - Device dump L45~59 Silent Push 상태 (permission=granted, received=7, fired=0, lastSkipped=14:32:30)
 * - Device dump L79 `08:37:25 | bg | fired | station-passed | 성수` — 결정적 회귀 지점
 * - Device dump L156~282 Alarm log 아침 부분 (fg-evaluated destination-early 성수 스팸)
 *
 * 재현 대상 silent push payload:
 *   1. 성수 station-passed (오늘 실 fired 된 것) — Issue B 봉인 후 skip 되어야 함
 *   2. 성수 destination-early (오늘 스팸 반복 - suppressed) — 현재 suppressed, 회귀 방어
 *   3. archFlag=on 시 boardingLine=undefined payload — Wave 1 완결 후 기대 shape
 */

import type { SilentPushPayload } from '../../tasks/silentPushTask';

/**
 * 08:37:25 KST — backend station-passed 성수 push 재현.
 *
 * dump L79 `bg fired station-passed 성수` 실 발사 evidence.
 * 실 backend payload 는 `boardingLine: '2'` 등을 실었을 것으로 추정 (Issue B 대상).
 *
 * archFlag='off' (실 배포 상태) 시:
 *   - lock=null 상태에서도 backend 가 boardingLine 실은 push 발사 → device authoritative pass → fire.
 *   - device silentPushTask 는 payload.boardingLine !== undefined 를 authoritative 로 취급.
 *   - handleSilentPush → fireWithGate → line 가드 → lockless opt-out 우회 → 발사.
 *
 * archFlag='on' (Wave 1 완결 후 목표) 시:
 *   - backend 가 lock=null + archFlag=on 시 boardingLine 실지 않음 (Issue B fix).
 *   - device 는 lockless-opt-out gate 로 skip → 오늘 evidence 재발 방지.
 */
export const REGRESSION_PUSH_STATION_PASSED_SEONGSU_WITH_LINE: SilentPushPayload = {
  nextWaypoint: '성수',
  etaSeconds: 0,
  phase: 'imminent',
  kind: 'intermediate',
  sentAt: Date.UTC(2026, 6, 2, 23, 37, 25), // 2026-07-02T23:37:25.000Z = KST 2026-07-03 08:37:25
  pushId: 'evidence-junggok-seongsu-am-station-passed',
  hopIndex: 3, // destination waypoint (성수) 의 hop index
  subsurface: false, // dump raw signal 08:37:25 sub=false
  // ★ Issue B 회귀 지점 — 오늘 실제 backend 가 실었을 것으로 추정. lock=null 인데도 실어서 device 발사.
  boardingLine: '2',
  occupiedLine: '2',
  tripToken: 'apns-junggok-seongsu',
};

/**
 * 08:37:25 KST — Wave 1 완결 후 예상 payload shape.
 *
 * Issue B fix 후 backend 는 archFlag=on + lock=null 시 boardingLine 실지 않음.
 * device 는 lockless-opt-out gate 로 fire 를 skip.
 */
export const TARGET_PUSH_STATION_PASSED_SEONGSU_LOCKLESS_OPT_OUT: SilentPushPayload = {
  nextWaypoint: '성수',
  etaSeconds: 0,
  phase: 'imminent',
  kind: 'intermediate',
  sentAt: Date.UTC(2026, 6, 2, 23, 37, 25),
  pushId: 'evidence-junggok-seongsu-am-station-passed-target',
  hopIndex: 3,
  subsurface: false,
  // ★ Wave 1 완결 후: boardingLine 봉인 (Issue B fix).
  boardingLine: undefined,
  occupiedLine: undefined,
  tripToken: 'apns-junggok-seongsu',
};

/**
 * 08:29 무렵 destination-early 성수 push 재현 (실 사용자 alarm log 스팸).
 *
 * dump L166~ `fg-evaluated destination early 성수` 20건+ 반복 → arc 폭주 (Issue J)
 * 로 인해 hop 진행 왜곡 → 성수 destination-early 조기 도달 판정.
 */
export const REGRESSION_PUSH_DESTINATION_EARLY_SEONGSU: SilentPushPayload = {
  nextWaypoint: '성수',
  etaSeconds: 300, // arc 계산 오류로 실제보다 훨씬 이른 시점에 도달 예상.
  phase: 'early',
  kind: 'destination',
  sentAt: Date.UTC(2026, 6, 2, 23, 29, 0),
  pushId: 'evidence-junggok-seongsu-am-destination-early',
  hopIndex: 3,
  subsurface: false,
  boardingLine: '2',
  occupiedLine: '2',
  tripToken: 'apns-junggok-seongsu',
};

/**
 * BG task 입력 payload 를 그대로 재현하는 helper.
 *
 * iOS BackgroundEventTransformer 는 `{aps, data:{fields}}` 를
 * `{data: {data: fields, dataString: null}, notification: null, aps}` 로 변환.
 * silentPushTask.handleSilentPush 는 이 3단 중첩 형태를 그대로 받는다.
 */
export function makeBgTaskInput(payload: SilentPushPayload): {
  data: {
    data: { data: Record<string, unknown>; dataString: null };
    notification: null;
    aps: { 'content-available': 1 };
  };
} {
  // undefined 값은 JSON 직렬화에서 자연 누락 — 실 backend wire 동작과 동일.
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) fields[k] = v;
  }
  return {
    data: {
      data: { data: fields, dataString: null },
      notification: null,
      aps: { 'content-available': 1 },
    },
  };
}

/**
 * 재발 판정 요약 (backend fixture 의 REGRESSION_TABLE 과 짝지어 사용).
 * device side 는 주로 Issue B (payload → skip 판정) 를 검증.
 */
export interface DeviceRegressionAssertion {
  issue: 'A' | 'B' | 'C' | 'E' | 'J' | 'K';
  device: string; // device 관점 검증 요약
}

export const DEVICE_REGRESSION_ASSERTIONS: readonly DeviceRegressionAssertion[] = [
  {
    issue: 'A',
    device: '새 route 등록 후 device 가 stale trip token 을 authoritative 로 취급하지 않음',
  },
  {
    issue: 'B',
    device: 'payload.boardingLine=undefined 시 lockless-opt-out skip (재발 방지)',
  },
  {
    issue: 'C',
    device: 'boarding-prompt alert push 수신 시 BOARDING_PROMPT UI 도달 (device UX layer)',
  },
  {
    issue: 'E',
    device: 'destination arrival trip-ended 수신 시 route summary UI cleanup chain 완결',
  },
  {
    issue: 'J',
    device: 'arc overshoot 상태 fusion picker 가 hop advance 자체를 pause',
  },
  {
    issue: 'K',
    device: 'destination-early payload 수신 시 arc guard 통과 여부 검증 후 fire',
  },
];
