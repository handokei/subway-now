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
import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC as SHARED_CRON_TTL } from './kvConsistency';
import type { ApnsEnv } from './types';

const PENDING_PREFIX = 'pending:';
export const PENDING_TTL_SEC = 60;

/**
 * cron read의 KV cacheTtl (#766/#770). trips.ts와 같은 이유 — silent push 발사 직후 putPending된
 * entry를 같은 cron 사이클(또는 다음)의 fallback이 못 보는 stale read를 방지.
 * 기본 60s는 fallback이 막 발사된 push의 sentAt을 못 봐 임계 평가가 어긋날 위험이 있다.
 * Cloudflare KV cacheTtl 최소값은 30s(#770 hotfix) — 그보다 작으면 런타임에서 `Invalid cache_ttl` 던짐.
 */
const CRON_READ_CACHE_TTL_SEC = SHARED_CRON_TTL;

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
  /** APNs host 선택 (sandbox/production). silent push가 self-heal로 정정된 경우 정정된 값을 보관. */
  apnsEnv: ApnsEnv;
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
 * P2c fallback 발사 경로용 — KV의 pending entry를 enumerate한다.
 * trips.ts의 listTrips와 동일 패턴: prefix scan + cursor 페이지네이션.
 * 손상된 JSON entry는 스킵 (TTL로 자동 정리됨).
 */
export async function* listPending(
  kv: KVNamespace | undefined,
): AsyncGenerator<PendingPush> {
  if (!kv) return;
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: PENDING_PREFIX, cursor });
    for (const key of result.keys) {
      // #766/#1402 — cacheTtl=30s로 putPending 직후 옛 캐시 read 차단(<30 KV runtime throw).
      // cron 전용 enumerate라 POST 경로 영향 없음. assertCronCacheTtl이 신규 callsite 회귀 차단.
      assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
      if (!raw) continue;
      try {
        yield JSON.parse(raw) as PendingPush;
      } catch {
        // 손상된 entry는 스킵.
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

/**
 * P2c가 alert fallback 발사 후 호출 — entry 삭제로 다음 cron에서 재발사 방지.
 * ackPending과 달리 token 인증 없이 무조건 삭제 (caller가 백엔드 cron이므로 인증 불필요).
 */
export async function removePending(
  kv: KVNamespace | undefined,
  pushId: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(pendingKey(pushId));
}

/**
 * #1370 L5 — silent push 도달률 observability stamp.
 *
 * 디바이스가 push 수신 시점에 `outcome: 'received'`로 ack를 보내면 이 함수가 호출된다.
 * outcome ack(fired/skipped)와 달리 pending entry를 삭제하지 않는다 — 게이트 평가가 아직
 * 끝나지 않았기 때문(P2c fallback 결정은 이후 fired/skipped ack로 처리).
 *
 * 단순 KV stamp로 "이 pushId가 디바이스에 도달했다"는 사실만 기록한다. 백엔드 tail에는
 * `reschedule push → 어린이대공원` 같은 pushed 이벤트가 남아 있고, 사용자/agent가 RCA 시
 * `received:<pushId>` stamp 존재 여부로 pushed vs received를 1:1 비교할 수 있다.
 *
 * TTL 1h — 회귀 분석 윈도우. KV cacheTtl 최소값(30s)과 무관하게 stamp는 1h 보존.
 */
const RECEIVED_PREFIX = 'received:';
export const RECEIVED_TTL_SEC = 60 * 60;

export function receivedKey(pushId: string): string {
  return `${RECEIVED_PREFIX}${pushId}`;
}

/**
 * `outcome: 'received'` ack 처리 결과. 임의 echo 차단을 위해 outcome ack와 동일하게
 * pending.token 매칭을 요구한다.
 *  - `stamped: true` — pending entry 매칭 + stamp 적재
 *  - `stamped: false, reason: 'not-found'` — pending entry 부재 (TTL 초과 / 잘못된 pushId)
 *  - `stamped: false, reason: 'token-mismatch'` — 다른 디바이스가 임의 echo
 */
export interface ReceivedAckResult {
  stamped: boolean;
  reason?: 'not-found' | 'token-mismatch';
}

export async function stampReceived(
  kv: KVNamespace | undefined,
  pushId: string,
  token: string,
  receivedAt: number,
  // #1768 — 권한별 도달률 집계. legacy device 미전송 시 undefined (graceful).
  permissionMode?: 'always' | 'whileInUse' | 'denied',
): Promise<ReceivedAckResult> {
  if (!kv) return { stamped: false, reason: 'not-found' };
  const entry = await getPending(kv, pushId);
  if (!entry) return { stamped: false, reason: 'not-found' };
  if (entry.token !== token) return { stamped: false, reason: 'token-mismatch' };
  const stampValue: {
    pushId: string;
    receivedAt: number;
    stationName: string;
    phase: string;
    permissionMode?: 'always' | 'whileInUse' | 'denied';
  } = { pushId, receivedAt, stationName: entry.stationName, phase: entry.phase };
  if (permissionMode !== undefined) stampValue.permissionMode = permissionMode;
  await kv.put(receivedKey(pushId), JSON.stringify(stampValue), {
    expirationTtl: RECEIVED_TTL_SEC,
  });
  return { stamped: true };
}

/**
 * #1370 L5 — RCA 시 `received:<pushId>` stamp 조회. stamp 부재 = push가 디바이스에
 * 도달하지 않음(또는 도달 후 task 시작 전 OS suspend).
 */
export async function getReceivedStamp(
  kv: KVNamespace | undefined,
  pushId: string,
): Promise<{ pushId: string; receivedAt: number; stationName: string; phase: AlarmPhase } | null> {
  if (!kv) return null;
  const raw = await kv.get(receivedKey(pushId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      pushId: string;
      receivedAt: number;
      stationName: string;
      phase: AlarmPhase;
    };
  } catch {
    return null;
  }
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
