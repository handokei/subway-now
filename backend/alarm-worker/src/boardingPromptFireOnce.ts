/**
 * boarding-prompt fire-once KV key — #2838.
 *
 * ## 배경
 *
 * 9/30 실측 트립(e25e1158, D1) — leg-boarding-prompt:
 *   06:42:11 fired
 *   06:43:08 silenced (repeat gate 정상)
 *   06:44:10 fired ← **5분 게이트(`MIN_FIRE_INTERVAL_MS`) 우회, 회귀**
 *
 * Root cause: 발사 권위는 단일(cron)이나, dedup 상태(`trip.legBoardingPromptState.lastFiredAt`)가
 * trip 객체에 실려 KV를 왕복한다. cron이 trip을 `listTrips`(trips.ts, `cacheTtl: 30s` — KV
 * 최소값, 주석 #765가 이 stale-read를 자인)로 읽는데, 직전 cycle의 `putTrip`이 간헐적으로
 * 반영되지 않으면 repeat gate(`boardingPrompt.ts` `evaluateBoardingPromptRepeatGate`)의 입력
 * (`lastFiredAt`)이 사라져 게이트가 우회된다. `docs/agents/invariants.md` §1 trips.ts 항목 참고.
 *
 * 이 취약점은 단일 경로가 아니다 — leg-1 GPS-free(`maybeFireOriginBoardingPromptGpsFree`), leg-2
 * (`maybeFireLegBoardingPrompt`, 공유본체 `fireBoardingPromptForAnchor` 경유), GPS 9단 경로
 * (`evaluateAndMaybeFireBoardingPrompt`, 자체 발사 블록) **셋 다** 같은 클래스의 dedup을
 * trip 객체 경유로만 수행하고 있었다(2026-09-30 교차추적 감사, 세 경로 모두 이 모듈로 배선).
 *
 * ## 설계 (arvlcdFireOnceTtl.ts 패턴 재사용, 단 TTL 판정은 caller의 `now`로 직접)
 *
 * trip 객체를 경유하지 않는 **독립 KV key**로 "최근 fire 여부"를 보장한다 — cron이 매 cycle
 * `listTrips`로 읽어오는 stale trip 객체와 무관하게, 이 key는 발사 직후 직접 write하고 직접
 * read해 그 자체로 신선하다.
 *
 * `arvlcdFireOnceTtl.ts`(KV `expirationTtl`로만 만료를 맡기는 설계)와 달리, 이 모듈은 stamp된
 * 시각(`value`)을 caller가 넘긴 `now`와 직접 비교해 "5분 이내인가"를 판정한다(`checkBoardingPromptFireOnce`).
 * `evaluateBoardingPromptRepeatGate`(boardingPrompt.ts)의 `now - lastFiredAt < MIN_FIRE_INTERVAL_MS`
 * 판정과 **동일한 비교 방식**을 재사용하는 것 — repeat gate가 "지금(cron이 넘긴 now) 기준
 * 5분 경과했는가"로 판정하는 것과 이 fire-once key도 일관되게 동작해야, "5분 경과 후 다른 열차로
 * 정당하게 재발사"(evidence_20260804_replay.test.ts — 5분 간격 서로 다른 trainCode 3연속 발사)가
 * 이 이중 방어에 의해 부당하게 차단되지 않는다. KV `expirationTtl`은 그대로 stamp에 적용해 스토리지
 * cleanup 백스톱으로만 쓰고(자연 만료 이후 key 자체가 사라짐), 판정 자체는 `now` 비교가 SSoT다.
 *
 * `trip.legBoardingPromptState`/`trip.boardingPromptState`(repeat gate ledger)는 **무변경
 * 유지** — 이 fire-once key는 이중 방어(defense-in-depth)로 얹는다. 정책 변경(MAX_FIRE_COUNT,
 * silence 정책 등)은 전혀 하지 않는다 — "간격" 보강만.
 *
 * ## 인메모리 가드를 두지 않은 이유
 *
 * 최초 설계는 KV 위에 per-isolate 인메모리 Map(TTL 5분)을 추가로 얹으려 했으나, 이는 실질적으로
 * KV와 동일한 "최근 5분 발사 여부" 상태를 모듈 전역(`scheduled.ts`가 처리하는 모든 trip에 걸쳐
 * 공유)으로 중복 유지하는 것과 같다 — cron이 실제로 같은 trip/anchor를 한 invocation 안에서
 * 두 번 평가하는 호출 지점은 현재 존재하지 않는다(trip 객체 in-memory mutation이 같은 cycle 내
 * caller 간 이중 방어를 이미 제공한다). 모듈 전역 Map은 오히려 여러 trip/여러 테스트에 걸친 상태
 * 누수 위험만 키운다 — 존재 이유 없는 복잡도는 추가하지 않는다(CLAUDE.md "Demand Elegance").
 *
 * ## hop-end("하차하셨나요?")에는 이 모듈을 쓰지 않은 이유
 *
 * hop-end(`maybeFireHopEndPrompt`)는 이미 #2672에서 동일 목적의 trip-독립 KV 마커
 * (`hopEndPromptFiredKey`, `HOP_END_PROMPT_FIRED_KEY_PREFIX`)를 갖고 있다 — 발사 직전
 * `env.TRIPS.get(firedKey)`로 직접 확인(`alreadyFiredAcrossRequests`), 성공 직후에만 stamp.
 * stale-read로 `trip.hopEndPromptState`가 비어 보여도 이 독립 마커가 이미 막는다(테스트:
 * scheduled.test.ts "#2672 — 다른 요청이 이미 발사해 KV 마커가 있으면, trip 상태가 깨끗해도
 * 재발사하지 않는다", 2026-09-30 교차추적 감사 재확인 — 이 시나리오로 실행해도 GREEN, 신규
 * 취약점 아님). hop-end 정책 자체도 boarding-prompt(5분 간격 최대 3회 반복 허용)와 달라
 * "leg당 영구 1회"(`evaluateHopEndPromptGates`, 5분 TTL이 아니라 1시간 `ARVLCD_FIRE_DEDUP_TTL_SEC`
 * 사용) — 이 모듈의 5분 TTL 키를 얹으면 의미가 다른 두 dedup 메커니즘이 같은 leg에 공존해 오히려
 * 혼란만 키운다. 별도 조치 불필요.
 */

import type { Env } from './types';

/**
 * `MIN_FIRE_INTERVAL_MS`(boardingPrompt.ts, 5분)와 정합. KV `expirationTtl`(스토리지 cleanup
 * 백스톱)에도 그대로 쓴다 — 최소값(60s)보다 크므로 유효.
 */
export const BOARDING_PROMPT_FIRE_ONCE_TTL_SEC = 5 * 60;
const BOARDING_PROMPT_FIRE_ONCE_TTL_MS = BOARDING_PROMPT_FIRE_ONCE_TTL_SEC * 1000;

/** KV key prefix. 형식: `promptFireOnce:{tripToken}:{anchorKey}`. */
export const BOARDING_PROMPT_FIRE_ONCE_KEY_PREFIX = 'promptFireOnce:';

/**
 * Fire-once KV key 빌더.
 *
 * @param token     trip token (per-trip isolation).
 * @param anchorKey leg-1(origin)은 origin station, leg-2는 `currentLegAnchor.boardingStation`
 *                  — caller(`fireBoardingPromptForAnchor`)가 이미 갖고 있는 `station` 파라미터를
 *                  그대로 전달해 leg별 독립 dedup을 보장한다.
 */
export function boardingPromptFireOnceKey(token: string, anchorKey: string): string {
  return `${BOARDING_PROMPT_FIRE_ONCE_KEY_PREFIX}${token}:${anchorKey}`;
}

/**
 * KV 에 이미 "최근(5분 이내) fire" stamp 가 있는지 확인. 판정은 KV `expirationTtl`이 아니라
 * stamp된 `value`(fire 시각)와 caller가 넘긴 `now`의 직접 비교로 한다(모듈 헤더 설명 참고) —
 * `evaluateBoardingPromptRepeatGate`의 `now - lastFiredAt < MIN_FIRE_INTERVAL_MS`와 동일 기준.
 *
 * @returns true — 최근(5분 이내) 발사됨 (skip 필요). false — 미stamp 이거나 5분 경과 (발사 진행 가능).
 */
export async function checkBoardingPromptFireOnce(
  kv: KVNamespace,
  token: string,
  anchorKey: string,
  now: number,
): Promise<boolean> {
  const key = boardingPromptFireOnceKey(token, anchorKey);
  const existing = await kv.get(key);
  if (existing === null) return false;
  const firedAt = Number(existing);
  if (!Number.isFinite(firedAt)) return false; // 손상된 값은 보수적으로 "미발사"로 간주.
  return now - firedAt < BOARDING_PROMPT_FIRE_ONCE_TTL_MS;
}

/**
 * Fire-once stamp 를 write. 성공 fire 직후에만 caller 가 호출한다(#2073 quota — 매 cycle
 * write 금지, 성공 fire 시 1회만).
 *
 * value 는 stamp 시각(`now`) ms — `checkBoardingPromptFireOnce`가 이 값으로 경과 시간을
 * 판정한다. KV `expirationTtl`은 그와 별개로 스토리지 cleanup 백스톱용(자연 만료 후 key 제거).
 */
export async function stampBoardingPromptFireOnce(
  kv: KVNamespace,
  token: string,
  anchorKey: string,
  now: number,
): Promise<void> {
  const key = boardingPromptFireOnceKey(token, anchorKey);
  await kv.put(key, String(now), { expirationTtl: BOARDING_PROMPT_FIRE_ONCE_TTL_SEC });
}

/**
 * caller(`fireBoardingPromptForAnchor`, `evaluateAndMaybeFireBoardingPrompt`)가 발사 직전
 * 호출하는 판정 — `env.TRIPS` KV를 직접 조회.
 */
export async function isBoardingPromptFireOnceBlocked(
  env: Env,
  token: string,
  anchorKey: string,
  now: number,
): Promise<boolean> {
  return checkBoardingPromptFireOnce(env.TRIPS, token, anchorKey, now);
}
