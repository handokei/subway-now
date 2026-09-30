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
 * ## 설계 (arvlcdFireOnceTtl.ts 패턴 재사용)
 *
 * trip 객체를 경유하지 않는 **독립 KV key**로 "최근 fire 여부"를 보장한다 — cron이 매 cycle
 * `listTrips`로 읽어오는 stale trip 객체와 무관하게, 이 key는 발사 직후 직접 write하고 직접
 * read해 그 자체로 신선하다. 이 key의 KV read 자체도 30s cacheTtl(KV 최소값)의 영향을 받지만,
 * TTL 자체가 5분이므로 그 정도의 read staleness는 정책 위반(5분 창 전체 우회)을 만들지 않는다
 * — 최악의 경우도 "이미 발사됨"을 몇 초 늦게 인지하는 정도다.
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
 * 두 번 평가하는 호출 지점은 현재 존재하지 않는다(leg-1 GPS 경로/leg-1 GPS-free/leg-2 세 경로가
 * 각각 1회씩만 `fireBoardingPromptForAnchor`를 호출하며, trip 객체 in-memory mutation
 * (`markPromptFired`가 동기적으로 trip.*PromptState를 갱신)이 같은 cycle 내 caller 간 이중
 * 방어를 이미 제공한다). 모듈 전역 Map은 오히려 여러 trip/여러 테스트에 걸친 상태 누수 위험만
 * 키운다(테스트마다 명시적 reset 필요) — 존재 이유 없는 복잡도는 추가하지 않는다(CLAUDE.md
 * "Demand Elegance"). 향후 실제 이중 호출 지점이 생기면 그때 좁은 스코프로 재도입한다.
 */

import type { Env } from './types';

/**
 * `MIN_FIRE_INTERVAL_MS`(boardingPrompt.ts, 5분)와 정합. KV `expirationTtl` 최소값(60s)보다
 * 크므로 그대로 사용 가능.
 */
export const BOARDING_PROMPT_FIRE_ONCE_TTL_SEC = 5 * 60;

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
 * KV 에 이미 fire-once stamp 가 있는지 확인.
 *
 * @returns true — 최근(5분 이내) 발사됨 (skip 필요). false — 미stamp (발사 진행 가능).
 */
export async function checkBoardingPromptFireOnce(
  kv: KVNamespace,
  token: string,
  anchorKey: string,
): Promise<boolean> {
  const key = boardingPromptFireOnceKey(token, anchorKey);
  const existing = await kv.get(key);
  return existing !== null;
}

/**
 * Fire-once stamp 를 5분 TTL 로 write. 성공 fire 직후에만 caller 가 호출한다(#2073 quota —
 * 매 cycle write 금지, 성공 fire 시 1회만).
 *
 * value 는 stamp 시각 ms — 관측 시 몇 초 전에 stamp 됐는지 tail 에서 즉시 확인 가능.
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
 * caller(`fireBoardingPromptForAnchor`)가 발사 직전 호출하는 판정 — `env.TRIPS` KV를 직접 조회.
 */
export async function isBoardingPromptFireOnceBlocked(
  env: Env,
  token: string,
  anchorKey: string,
): Promise<boolean> {
  return checkBoardingPromptFireOnce(env.TRIPS, token, anchorKey);
}
