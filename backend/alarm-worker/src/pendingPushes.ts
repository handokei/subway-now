/**
 * KV CRUD for pending silent pushes (#566 P2a).
 *
 * 발사한 silent push 1건마다 `pending:<pushId>` entry를 기록한다.
 * P2c가 이 entry를 폴링해 30s 안에 디바이스 ACK가 안 오면 alert push fallback을 발사한다.
 * 디바이스 ACK 도달 시 P2a /push/ack 라우트가 entry를 삭제한다.
 *
 * 모든 함수는 `kv === undefined`(미바인딩)일 때 graceful no-op — 개발 환경 호환.
 *
 * Key format: pending:<pushId>
 * TTL: 60s (Cloudflare KV 최소값). P2c는 30s 임계는 sentAt 시각 기준으로 판단.
 */

import type { AlarmPhase } from './alarm';

const PENDING_PREFIX = 'pending:';
export const PENDING_TTL_SEC = 60;

/** silent push 발사 1건의 추적 정보. P2c가 alert fallback 결정에 사용. */
export interface PendingPush {
  pushId: string;
  /** APNs device token — fallback 재발사 시 사용. */
  token: string;
  /** dedup 식별자 — 디바이스 FIRED_ALARMS와 매칭. `${stationName}:${kind}:${phase}` 형태. */
  alarmKey: string;
  /** 백엔드 발사 시점 epoch ms. P2c가 30s 임계 판단. */
  sentAt: number;
  /** alert fallback 본문 생성용 메타 (P2c/P2d에서 사용). */
  stationName: string;
  kind: 'transfer' | 'destination' | 'intermediate';
  phase: AlarmPhase;
  etaSeconds: number;
}

export function pendingKey(pushId: string): string {
  return `${PENDING_PREFIX}${pushId}`;
}

/**
 * dedup 식별자 빌드. 디바이스 측 `alarmKey(event)`와 **바이트 동일** 결과를 낸다.
 * 디바이스: `${phaseId}:${stationName}` (src/utils/stationAlarm.ts).
 * 디바이스는 type/kind를 키에 포함하지 않으므로 백엔드도 마찬가지로 처리해야 P2e dedup이 매칭된다.
 * kind 자체는 PendingPush 본문에 유지 — P2c가 alert 본문 생성에 사용.
 */
export function buildAlarmKey(stationName: string, phase: AlarmPhase): string {
  return `${phase}:${stationName}`;
}

export async function putPending(
  kv: KVNamespace | undefined,
  entry: PendingPush,
): Promise<void> {
  if (!kv) return;
  await kv.put(pendingKey(entry.pushId), JSON.stringify(entry), {
    expirationTtl: PENDING_TTL_SEC,
  });
}

export async function getPending(
  kv: KVNamespace | undefined,
  pushId: string,
): Promise<PendingPush | null> {
  if (!kv) return null;
  const raw = await kv.get(pendingKey(pushId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingPush;
  } catch {
    return null;
  }
}

/**
 * ACK 처리 결과.
 * - `deleted: true` — 디바이스가 발급된 token으로 정상 ACK, entry 삭제 완료
 * - `deleted: false, reason: 'not-found'` — entry가 만료/이미 처리됨 (idempotent OK)
 * - `deleted: false, reason: 'token-mismatch'` — 다른 디바이스가 임의 pushId echo (인증 실패)
 */
export interface AckResult {
  deleted: boolean;
  reason?: 'not-found' | 'token-mismatch';
}

/**
 * ACK 처리. caller가 device token도 함께 보내야 임의 pushId echo로 인한 fallback 무력화를 차단한다.
 * KV에 저장된 pending.token과 매칭하지 않으면 삭제하지 않는다.
 */
export async function ackPending(
  kv: KVNamespace | undefined,
  pushId: string,
  token: string,
): Promise<AckResult> {
  if (!kv) return { deleted: false, reason: 'not-found' };
  const entry = await getPending(kv, pushId);
  if (!entry) return { deleted: false, reason: 'not-found' };
  if (entry.token !== token) return { deleted: false, reason: 'token-mismatch' };
  await kv.delete(pendingKey(pushId));
  return { deleted: true };
}
