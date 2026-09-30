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
 * read해 그 자체로 신선하다(30s cacheTtl은 이 key의 KV read에도 적용되지만, TTL 자체가
 * 5분이므로 30s 정도의 read staleness는 정책 위반을 만들지 않는다 — 최악의 경우도 게이트가
 * "이미 발사됨"을 못 보고 몇 초 늦게 인지하는 것이지, 5분 창을 통째로 우회하지는 않는다).
 *
 * `trip.legBoardingPromptState`/`trip.boardingPromptState`(repeat gate ledger)는 **무변경
 * 유지** — 이 fire-once key는 이중 방어(defense-in-depth)로 얹는다. 정책 변경(MAX_FIRE_COUNT,
 * silence 정책 등)은 전혀 하지 않는다 — "간격" 보강만.
 *
 * ## 인메모리 가드
 *
 * KV round-trip(수 ~수십 ms)보다도 빠르게 같은 isolate 내에서 같은 (token, anchor)가 재평가되는
 * 경우(같은 cycle 이중 평가, 또는 KV eventual consistency 창)를 추가로 방어한다. 이 Map은
 * per-isolate 휘발성 캐시일 뿐 durable 하지 않다 — 진짜 durability는 KV가 담당한다.
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
 * @param anchorKey leg-1(origin)은 `origin` 또는 origin station, leg-2는 `currentLegAnchor.
 *                  boardingStation` — caller(`fireBoardingPromptForAnchor`)가 이미 갖고 있는
 *                  `station` 파라미터를 그대로 전달해 leg별 독립 dedup을 보장한다.
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
 * Per-isolate 인메모리 가드 — 같은 isolate 같은 cycle 이중 평가 대비(KV round-trip보다 빠른
 * 중복 호출 또는 KV eventual consistency 창을 추가 방어). Durable 하지 않음 — KV가 SSoT.
 */
const inMemoryFireOnce = new Map<string, number>();

function pruneExpiredInMemoryEntries(now: number): void {
  for (const [key, expiresAt] of inMemoryFireOnce) {
    if (expiresAt <= now) inMemoryFireOnce.delete(key);
  }
}

/** @returns true — 인메모리 캐시상 최근(5분 이내) 발사됨(skip). false — 미기록. */
export function checkBoardingPromptFireOnceInMemory(
  token: string,
  anchorKey: string,
  now: number,
): boolean {
  pruneExpiredInMemoryEntries(now);
  const expiresAt = inMemoryFireOnce.get(boardingPromptFireOnceKey(token, anchorKey));
  return expiresAt !== undefined && expiresAt > now;
}

/** 발사 성공 직후 caller 가 호출 — 인메모리 캐시에도 동일 TTL 로 stamp. */
export function stampBoardingPromptFireOnceInMemory(
  token: string,
  anchorKey: string,
  now: number,
): void {
  inMemoryFireOnce.set(
    boardingPromptFireOnceKey(token, anchorKey),
    now + BOARDING_PROMPT_FIRE_ONCE_TTL_SEC * 1000,
  );
}

/**
 * 테스트 전용 — 인메모리 캐시를 초기화한다. 모듈 스코프 상태라 테스트 간 누수 방지용.
 */
export function resetBoardingPromptFireOnceInMemoryForTest(): void {
  inMemoryFireOnce.clear();
}

/**
 * caller(`fireBoardingPromptForAnchor`)가 발사 직전 호출하는 통합 판정 — 인메모리 우선(cheap),
 * 없으면 KV(durable) 순서로 검사한다.
 */
export async function isBoardingPromptFireOnceBlocked(
  env: Env,
  token: string,
  anchorKey: string,
  now: number,
): Promise<boolean> {
  if (checkBoardingPromptFireOnceInMemory(token, anchorKey, now)) return true;
  return checkBoardingPromptFireOnce(env.TRIPS, token, anchorKey);
}

/** 발사 성공 직후 caller 가 호출 — 인메모리 + KV 동시 stamp. */
export async function stampBoardingPromptFireOnceBoth(
  env: Env,
  token: string,
  anchorKey: string,
  now: number,
): Promise<void> {
  stampBoardingPromptFireOnceInMemory(token, anchorKey, now);
  await stampBoardingPromptFireOnce(env.TRIPS, token, anchorKey, now);
}
