/**
 * Device push-receipt 로그 (#2541, obs: whole-chain 관측).
 *
 * 목적: "매역 알림이 어디서 끊기는지(프롬프트/lock/발사/배달)"를 device-side에서 확정하기 위한
 * 마지막 단계(배달) 관측 채널. backend D1 `cron-fire-attempt`가 push를 보낸(sent) 기록은 이미
 * 있지만, 그 push가 실제로 device에 도달했는지/표시됐는지는 backend가 blind다 — device가 직접
 * 기록해야만 station+시각 기준으로 대조 가능하다.
 *
 * 저장 채널: #2861 (T1) 이전에는 `rawSignalBuffer`(fusion cycle과 공유, cap=300, FIFO)에 함께
 * 적재했으나, 긴 트립 초반 receipt가 cycle entry에 밀려 증발하는 결함이 있었다(DebugModal Whole
 * Chain 패널이 역 행 자체를 생략). 이제 cycle/enter/exit과 cap을 공유하지 않는 독립 소형 채널
 * `pushReceiptBuffer`(cap=60)에 적재한다 — 새 인프라 신설이 아니라 기존 `createDebugBuffer`
 * (gpsDropBuffer 등과 동일 패턴) 재사용.
 *
 * 관측 전용 — 이 모듈은 발사/표시/dedup 동작을 바꾸지 않는다. 호출자가 이미 결정한 결과
 * (displayed/suppressedReason)를 그대로 기록만 한다.
 */
import {
  pushPushReceiptEntry,
  type PushReceiptBufferEntry,
} from './pushReceiptBuffer';
import type {
  PushReceiptDetail,
  PushReceiptDisplaySource,
  PushReceiptKind,
  PushReceiptType,
} from './rawSignalBuffer';
import { getCurrentTripCorrIdSync } from './tripCorrId';

export type { PushReceiptDetail, PushReceiptDisplaySource, PushReceiptKind, PushReceiptType };

export interface LogPushReceiptInput {
  pushId: string | null | undefined;
  station: string;
  kind: PushReceiptKind;
  pushType: PushReceiptType;
  displayed: boolean;
  suppressedReason?: string;
  /** #2930 — displayed=true일 때 "누가 표시했는가" 라벨. 의미는 PushReceiptDetail 주석 참고. */
  source?: PushReceiptDisplaySource;
  /** 테스트에서 결정적 ts 주입용. 미지정 시 `Date.now()`. */
  receivedAt?: number;
}

/**
 * push-receipt 1건을 pushReceiptBuffer(독립 채널)에 적재한다.
 *
 * #2861 (T1) — cycle/enter/exit(fusion 측정)과 cap을 공유하지 않는다 — 긴 트립에서 cycle entry가
 * 초반 receipt를 밀어내 증발시키는 결함(Whole Chain 패널 역 행 생략)을 막기 위함.
 */
export function logPushReceipt(input: LogPushReceiptInput): void {
  const detail: PushReceiptDetail = {
    pushId: input.pushId ?? null,
    station: input.station,
    kind: input.kind,
    pushType: input.pushType,
    displayed: input.displayed,
    ...(input.suppressedReason !== undefined ? { suppressedReason: input.suppressedReason } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  const entry: PushReceiptBufferEntry = {
    ts: input.receivedAt ?? Date.now(),
    corrId: getCurrentTripCorrIdSync(),
    detail,
  };
  pushPushReceiptEntry(entry);
}

/**
 * backend `StationWaypointKind`('intermediate'|'transfer'|'destination')를 device
 * `PushReceiptKind`로 매핑. 'intermediate'만 이름이 다르다('station-passed') — 그 외는 identity.
 */
export function mapWaypointKindToReceiptKind(
  waypointKind: 'intermediate' | 'transfer' | 'destination',
): PushReceiptKind {
  return waypointKind === 'intermediate' ? 'station-passed' : waypointKind;
}
