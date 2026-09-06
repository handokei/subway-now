/**
 * #916 — autoLock 상수 모듈.
 *
 * #1729 paradigm shift: `attemptAutoLock` / `recordAutoLockConfidence` 제거.
 * 사용자가 BoardingTrainList에서 명시 탭하지 않은 trainCode에 backend가 자동으로 lock 부착 X.
 * 9단 게이트 통과 시 boardingPrompt push 발사 → 사용자 인지/응답 요구.
 *
 * 잔존 상수:
 *   - `AUTO_LOCK_TTL_MS` — lockSwap.SWAP_LOCK_TTL_MS와 동일 30분. 기존 lock TTL 정책 유지.
 *   - `AUTO_PROMPT_DEDUP_WINDOW_MS` — `scheduled.ts` / `index.ts`가 lastAutoPromptedAt dedup에 사용.
 */

import { SWAP_LOCK_TTL_MS } from './lockSwap';

/**
 * 자동 lock의 TTL. lockSwap의 `SWAP_LOCK_TTL_MS`와 동일 30분.
 *
 * #1729: attemptAutoLock 제거로 신규 auto-lock은 발생하지 않으나, 기존 trip에 stamp된
 * `expiresAt` 참조 코드(index.ts 등)와의 호환을 위해 상수는 유지한다.
 */
export const AUTO_LOCK_TTL_MS = SWAP_LOCK_TTL_MS;

/**
 * #916 follow-up B — auto-prompt 발사 dedup 윈도우.
 *
 * `evaluateAndMaybeFireBoardingPrompt` / `index.ts` POST /trips 핸들러가
 * `lastAutoPromptedAt` 기준으로 재발사를 차단하는 윈도우. 길이는 `AUTO_LOCK_TTL_MS`(=30분)와 동일.
 */
export const AUTO_PROMPT_DEDUP_WINDOW_MS = AUTO_LOCK_TTL_MS;
