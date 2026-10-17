/**
 * #2617 — fallback implicit ACK를 위한 device 접촉 stamp.
 *
 * 배경: FG(포그라운드) trip은 silent push 전달이 iOS 레벨에서 불확실해 `push/ack`
 * (outcome=received) 명시 ACK가 오지 않는 경우가 실측됐다 (2026-09-14, 뚝섬/성수 fallback
 * pile — FG 내내 silent_push_received=0). 하지만 FG 상태라면 `/position`(10초 주기)이나
 * `/boarding-lock/sync`(사용자 관측 sync, FG 전용) 채널로 device가 계속 backend와 통신 중이므로,
 * 이 접촉 자체를 "device가 살아있고 화면에서 정보를 보고 있다"는 implicit ACK로 쓸 수 있다.
 *
 * RCA(신규 키 최소화 원칙, #2617 spec) — 기존 stamp 재사용 가능성을 조사한 결과:
 *   - `cronIdleGate.ts`의 `stampPushActivity`는 global 단일 marker(`cron:push-activity`)라
 *     trip/token 단위 판정이 불가능 — 재사용 불가.
 *   - `pendingPushes.ts`의 `stampReceived`는 push/ack(outcome=received) 명시 ACK 전용이라
 *     본 이슈가 우회하려는 그 채널 자체(FG 미전달)에 의존 — 재사용하면 원 문제가 그대로 남는다.
 *   - `positionSeries`(KV `pos:{token}`, standalone 키)는 `/position`이 FG/BG 공유 채널이라
 *     **BG에서도 계속 기록된다** — 이 키의 존재/최신성만으로는 FG 여부를 판별할 수 없다
 *     (코드리뷰 지적: "접촉=FG"는 거짓 전제였다). `Trip.originProximityAt`도 같은 채널 출신이라
 *     동일하게 FG 판별력이 없고, 게다가 fallback 후보 판정 시점엔 아직 trip 존재 여부조차 확인
 *     전이라 매 후보마다 trip 전체를 로드해야 하는 오버헤드도 있다.
 *   → 재사용 후보 없음. tokenHash 단위 최소 KV 키(`deviceContact:{tokenHash}`) 신규 도입 +
 *     `/position` 호출부에는 명시적 `appState==='fg'` 게이트를 별도로 둔다(`index.ts` 참고) —
 *     "도달"이 아니라 "FG임이 계약으로 선언된 도달"만 stamp 채택.
 *
 * TTL 10분 — fallback 판정 임계(60s)보다 훨씬 길게 잡아, cron 지연/재시도 사이에도 최근 접촉
 * 기록이 살아있게 한다(과소 판정으로 인한 오탐 fallback 방지 쪽으로 보수적).
 */

import { CRON_READ_CACHE_TTL_SEC } from './kvConsistency';

const DEVICE_CONTACT_PREFIX = 'deviceContact:';

/** stamp TTL(초) — #2617 spec 명시치. */
export const DEVICE_CONTACT_TTL_SEC = 600;

/**
 * #2617 (코드리뷰 반영) — write rate limit. `/position`은 FG 상태에서 ~10초마다 호출되므로
 * 가드 없이 매번 write하면 KV free tier quota를 빠르게 소진한다(#2450/#2452 정책 위반).
 * 기존 stamp가 이 창 안이면 재write를 skip — implicit ACK 판정(60s 임계)은 10분 TTL 안에서
 * "최근 접촉이 있었는지"만 보므로, 분 단위 갱신 지연은 판정 정확도에 영향이 없다.
 */
export const STAMP_RATE_LIMIT_MS = 60_000;

function deviceContactKey(tokenHash: string): string {
  return `${DEVICE_CONTACT_PREFIX}${tokenHash}`;
}

/**
 * device 접촉 시각 stamp. `/position`(appState==='fg'만), `/boarding-lock/sync`(FG 전용
 * 액션) 처리부에서 호출한다. 호출자는 핫패스 응답 latency에 얹지 않도록 waitUntil로 스케줄한다
 * (#2283 관례, `index.ts`의 `scheduleTripEvent` 참고).
 *
 * write rate limit(`STAMP_RATE_LIMIT_MS`) — 기존 stamp가 60초 이내면 read만 하고 put은
 * skip한다. read 실패는 "기존 stamp 없음"으로 보수 처리해 put을 시도한다(관측 정밀도보다
 * fallback 안전망 유지가 우선). write 실패는 graceful — 다음 접촉 기회에서 자연 회복.
 */
export async function stampDeviceContact(
  kv: KVNamespace,
  tokenHash: string,
  now: number,
): Promise<void> {
  const existing = await readDeviceContact(kv, tokenHash);
  if (existing !== null && now - existing < STAMP_RATE_LIMIT_MS) {
    return;
  }
  try {
    await kv.put(deviceContactKey(tokenHash), String(now), {
      expirationTtl: DEVICE_CONTACT_TTL_SEC,
    });
  } catch {
    // silent — 관측/게이트 정밀도만 손실. 회귀 무해(기존 fallback 동작으로 회귀).
  }
}

/**
 * 최근 device 접촉 시각을 읽는다. 미기록/만료/read 실패는 `null` — 호출자(`runFallbackPushes`,
 * `stampDeviceContact`)는 `null`을 "implicit ACK/rate-limit 근거 없음"으로 취급해 각자 안전한
 * 기본 동작(fallback 정상 판정 / write 강행)으로 낙하한다.
 */
export async function readDeviceContact(
  kv: KVNamespace,
  tokenHash: string,
): Promise<number | null> {
  // #2617 (코드리뷰 반영) — `assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC)` 가드는 제거했다.
  // 인자가 항상 같은 상수(`CRON_READ_CACHE_TTL_SEC === KV_MIN_CACHE_TTL_SEC`)라 자기 자신과
  // 비교하는 셈이라 절대 throw할 수 없는데, 그마저도 바로 아래 catch가 삼켜 죽은 코드였다
  // (cronIdleGate.ts의 caller-공급 값 검증용 패턴을 무비판적으로 복사한 결과).
  try {
    const raw = await kv.get(deviceContactKey(tokenHash), { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
