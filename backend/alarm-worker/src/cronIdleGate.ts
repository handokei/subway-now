/**
 * #2073 — cron 진짜 idle skip 게이트.
 *
 * 배경: #2054 idle-skip은 함수 끝의 로그만 억제했고 KV 연산(listTrips 중복 3회, jitter write 등)은
 * 하나도 skip하지 않았다 (2026-07-29 quota 계수 audit — 사용자 0명 상태에서도 KV list 720%,
 * write 144% 초과).
 *
 * 본 모듈은 "활성 trip 부재 + 직전 tick 근방 fire/retry 기록 없음"을 진짜 idle로 판정하는
 * marker를 제공한다. pending/retry push entry는 활성 trip이 존재하는 tick에서만 새로 생성된다
 * (모든 fire 경로가 trip 기반) — 따라서 "trip 존재" 또는 "직전 tick 근방에 fire/retry 기록"
 * 이면 pending/retry가 아직 남아있을 가능성이 있다고 보수적으로 판단한다.
 *
 * `runScheduled`(scheduled.ts)가 trip 존재 시 stamp하고, `index.ts`가 runFallbackPushes /
 * runRetryPushes 가 실제로 entry를 발견했을 때 재stamp해 backoff가 긴 retry도 커버한다.
 */

import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';

const PUSH_ACTIVITY_KEY = 'cron:push-activity';

/**
 * marker TTL(초). cron 60s 주기의 최소 2 tick(120s) 이상 생존해야 "직전 tick" 판정이 다음
 * cycle에서도 유효하다. entry 발견 시 매번 재stamp되므로 backoff가 이보다 긴 retry는 그
 * 사이 cycle에서 계속 연장된다.
 */
export const PUSH_ACTIVITY_TTL_SEC = 120;

/**
 * 활성 trip 존재 또는 pending/retry backlog 발견 시 marker stamp.
 * KV 미바인딩 / write 실패는 graceful — 다음 tick이 안전 방향(idle 아님)으로 판정되므로
 * 서비스 영향 없음(관측 정밀도만 손실).
 */
export async function stampPushActivity(
  kv: KVNamespace | undefined,
  now: number,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(PUSH_ACTIVITY_KEY, String(now), { expirationTtl: PUSH_ACTIVITY_TTL_SEC });
  } catch {
    // silent — 관측/게이트 정밀도만 손실.
  }
}

/**
 * marker가 살아있는지(=직전 tick 근방 fire/retry 활동 기록) 여부.
 *
 * KV 미바인딩은 false(활동 없음) — binding 자체가 없으면 marker 개념이 무의미하고, 호출자가
 * `trips.length === 0 && !activityRecent`로 조합하므로 trip이 존재하면 어차피 idle이 아니다.
 *
 * read 실패(KV 장애)는 **true**를 반환한다 — "활동 기록을 확인할 수 없음"을 "활동 있을 수 있음"
 * 으로 보수 판정해 idle 오판을 피한다. false를 반환하면 `trips.length === 0`인 tick에서
 * `idle = true`가 되어 `runFallbackPushes`/`runRetryPushes`가 통째로 skip될 수 있고, 그 tick에
 * 마침 pending/retry backlog가 남아 있었다면 사용자 push가 지연된다 — read 실패는 드물게라도
 * fire/retry semantics에 영향을 줘선 안 된다(#2073 "하지 말 것").
 */
export async function readPushActivityRecent(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return false;
  try {
    // #2079 (P3-1) — 레포 컨벤션(assertCronCacheTtl)대로 cron KV read에 명시적 cacheTtl.
    // marker TTL(120s) 대비 30s 안전 마진.
    assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
    const raw = await kv.get(PUSH_ACTIVITY_KEY, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    return raw !== null;
  } catch {
    return true;
  }
}
