/**
 * Device push-receipt 로그 (#2541, obs: whole-chain 관측).
 *
 * 목적: "매역 알림이 어디서 끊기는지(프롬프트/lock/발사/배달)"를 device-side에서 확정하기 위한
 * 마지막 단계(배달) 관측 채널. backend D1 `cron-fire-attempt`가 push를 보낸(sent) 기록은 이미
 * 있지만, 그 push가 실제로 device에 도달했는지/표시됐는지는 backend가 blind다 — device가 직접
 * 기록해야만 station+시각 기준으로 대조 가능하다.
 *
 * 저장 채널: 기존 `rawSignalBuffer`(ring buffer, AsyncStorage 영속화 + share-dump 자동 포함)를
 * 그대로 재사용한다. 새 채널/엔드포인트 신설 없음(#2541 "하지 말 것" 준수).
 *
 * 관측 전용 — 이 모듈은 발사/표시/dedup 동작을 바꾸지 않는다. 호출자가 이미 결정한 결과
 * (displayed/suppressedReason)를 그대로 기록만 한다.
 */
import {
  pushRawSignal,
  type PushReceiptDetail,
  type PushReceiptKind,
  type PushReceiptType,
} from './rawSignalBuffer';
import { getCurrentTripCorrIdSync } from './tripCorrId';

export type { PushReceiptDetail, PushReceiptKind, PushReceiptType };

export interface LogPushReceiptInput {
  pushId: string | null | undefined;
  station: string;
  kind: PushReceiptKind;
  pushType: PushReceiptType;
  displayed: boolean;
  suppressedReason?: string;
  /** 테스트에서 결정적 ts 주입용. 미지정 시 `Date.now()`. */
  receivedAt?: number;
}

/**
 * push-receipt 1건을 rawSignalBuffer에 적재한다.
 *
 * `kind: 'push-receipt'` entry — cycle/enter/exit(fusion 측정)와 discriminate되며, GPS/motion/
 * fusion 관련 필드는 모두 null로 채운다(push-receipt는 fusion 측정과 무관한 별도 관측 축).
 */
export function logPushReceipt(input: LogPushReceiptInput): void {
  const detail: PushReceiptDetail = {
    pushId: input.pushId ?? null,
    station: input.station,
    kind: input.kind,
    pushType: input.pushType,
    displayed: input.displayed,
    ...(input.suppressedReason !== undefined ? { suppressedReason: input.suppressedReason } : {}),
  };
  pushRawSignal({
    ts: input.receivedAt ?? Date.now(),
    corrId: getCurrentTripCorrIdSync(),
    kind: 'push-receipt',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    barometerHpa: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    pushReceipt: detail,
  });
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
