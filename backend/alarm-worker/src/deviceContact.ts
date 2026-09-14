/**
 * #2617 — fallback implicit ACK를 위한 device 접촉 stamp.
 *
 * 배경: FG(포그라운드) trip은 silent push 전달이 iOS 레벨에서 불확실해 `push/ack`
 * (outcome=received) 명시 ACK가 오지 않는 경우가 실측됐다 (2026-09-14, 뚝섬/성수 fallback
 * pile — FG 내내 silent_push_received=0). 하지만 FG 상태라면 `/position`(10초 주기)이나
 * `/boarding-lock/sync`(사용자 관측 sync) 채널로 device가 계속 backend와 통신 중이므로,
 * 이 접촉 자체를 "device가 살아있고 화면에서 정보를 보고 있다"는 implicit ACK로 쓸 수 있다.
 *
 * RCA(신규 키 최소화 원칙, #2617 spec) — 기존 stamp 재사용 가능성을 조사한 결과:
 *   - `cronIdleGate.ts`의 `stampPushActivity`는 global 단일 marker(`cron:push-activity`)라
 *     trip/token 단위 판정이 불가능 — 재사용 불가.
 *   - `pendingPushes.ts`의 `stampReceived`는 push/ack(outcome=received) 명시 ACK 전용이라
 *     본 이슈가 우회하려는 그 채널 자체(FG 미전달)에 의존 — 재사용하면 원 문제가 그대로 남는다.
 *   - `Trip.originProximityAt`/positionSeries 등은 KV read마다 trip 전체를 로드해야 하고
 *     fallback 후보 판정 시점엔 아직 trip 존재 여부조차 확인 전이라 오버헤드가 크다.
 *   → 재사용 후보 없음. tokenHash 단위 최소 KV 키(`deviceContact:{tokenHash}`) 신규 도입.
 *
 * TTL 10분 — fallback 판정 임계(60s)보다 훨씬 길게 잡아, cron 지연/재시도 사이에도 최근 접촉
 * 기록이 살아있게 한다(과소 판정으로 인한 오탐 fallback 방지 쪽으로 보수적).
 */

import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';

const DEVICE_CONTACT_PREFIX = 'deviceContact:';

/** stamp TTL(초) — #2617 spec 명시치. */
export const DEVICE_CONTACT_TTL_SEC = 600;

function deviceContactKey(tokenHash: string): string {
  return `${DEVICE_CONTACT_PREFIX}${tokenHash}`;
}

/**
 * device 접촉 시각 stamp. `/position`, `/boarding-lock/sync` 처리부에서 호출한다.
 * write 실패는 graceful — 다음 접촉 기회(다음 cycle)에서 자연 회복, fallback은 기존(명시적)
 * 동작으로 안전하게 떨어진다.
 */
export async function stampDeviceContact(
  kv: KVNamespace,
  tokenHash: string,
  now: number,
): Promise<void> {
  try {
    await kv.put(deviceContactKey(tokenHash), String(now), {
      expirationTtl: DEVICE_CONTACT_TTL_SEC,
    });
  } catch {
    // silent — 관측/게이트 정밀도만 손실. 회귀 무해(기존 fallback 동작으로 회귀).
  }
}

/**
 * 최근 device 접촉 시각을 읽는다. 미기록/만료/read 실패는 `null` — 호출자(`runFallbackPushes`)는
 * `null`을 "implicit ACK 근거 없음"으로 취급해 기존 fallback 판정을 그대로 수행한다(안전 방향).
 */
export async function readDeviceContact(
  kv: KVNamespace,
  tokenHash: string,
): Promise<number | null> {
  try {
    assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
    const raw = await kv.get(deviceContactKey(tokenHash), { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
