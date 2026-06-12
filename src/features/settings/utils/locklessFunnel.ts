/**
 * Lockless 토글 학습 funnel — Epic #1008 Epic C 단기 11 (#1175).
 *
 * "전체역 보기" 토글이 사용자에게 어떻게 학습되는지 4 step funnel로 측정한다.
 * B1 UX 검증용 — 토글 ON/OFF 동작 자체는 변경하지 않고 순수 측정 layer만 추가한다.
 *
 *  - `viewed`  : Settings 화면에 토글이 노출 (SettingsScreen 마운트 시 세션당 1회 emit)
 *  - `on`      : OFF → ON 전환 (의미 학습 전/후 무관)
 *  - `off`     : ON → OFF 전환 (사용자가 "이게 뭔지" 파악 후 비활성화)
 *  - `re_on`   : 한 번 OFF 했던 사용자가 다시 ON — "이해 후 의도적 사용" 신호
 *
 * `re_on` 분류를 위해 "한 번이라도 OFF한 적이 있는지"를 AsyncStorage에 영속화한다
 * (`LOCKLESS_FUNNEL_SEEN_OFF_KEY`). 키가 'true'이면 다음 ON 전환은 `re_on`이다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCKLESS_FUNNEL_SEEN_OFF_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('locklessFunnel');

/** Funnel step 식별자. backend telemetry payload + 로컬 logger 양쪽에서 공유. */
export const LOCKLESS_FUNNEL_STEPS = {
  VIEWED: 'lockless_toggle.viewed',
  ON: 'lockless_toggle.on',
  OFF: 'lockless_toggle.off',
  RE_ON: 'lockless_toggle.re_on',
} as const;

export type LocklessFunnelStep =
  (typeof LOCKLESS_FUNNEL_STEPS)[keyof typeof LOCKLESS_FUNNEL_STEPS];

/**
 * Funnel emit sink. 기본 구현은 logger + backend client.
 * 테스트는 jest.spyOn으로 호출 검증 — 동작 자체는 graceful (실패해도 토글 흐름 안 막음).
 */
export type LocklessFunnelEmitter = (
  step: LocklessFunnelStep,
  meta?: Record<string, unknown>,
) => Promise<void>;

let activeEmitter: LocklessFunnelEmitter = async (step, meta) => {
  log.info(`funnel ${step}`, meta);
};

/**
 * 기본 emitter 교체 (테스트 + backend client 주입용).
 * 호출자가 직접 sink를 swap할 수 있게 하지만, 기본은 logger.
 */
export function setLocklessFunnelEmitter(emitter: LocklessFunnelEmitter): void {
  activeEmitter = emitter;
}

async function emit(step: LocklessFunnelStep, meta?: Record<string, unknown>): Promise<void> {
  try {
    await activeEmitter(step, meta);
  } catch (e) {
    log.warn(`emit failed step=${step}`, e);
  }
}

/**
 * SettingsScreen 마운트 시 호출. 토글이 뷰에 노출됐음을 1회 기록.
 * (현재 토글은 카드 안에 항상 렌더되므로 화면 진입 = 노출로 본다.)
 */
export async function emitLocklessToggleViewed(): Promise<void> {
  await emit(LOCKLESS_FUNNEL_STEPS.VIEWED);
}

/** 한 번이라도 OFF로 전환한 적이 있는지 (`re_on` 분류 기준). */
async function hasSeenOffOnce(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LOCKLESS_FUNNEL_SEEN_OFF_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

async function markSeenOff(): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCKLESS_FUNNEL_SEEN_OFF_KEY, 'true');
  } catch {
    // graceful — funnel은 best-effort.
  }
}

/**
 * 토글 transition emit. `setLocklessStationPassed` 직전에 prev 값과 next 값을 넘긴다.
 * 동일 값(no-op)은 emit하지 않는다 — 측정 노이즈 방지.
 */
export async function emitLocklessToggleTransition(
  prev: boolean,
  next: boolean,
): Promise<void> {
  if (prev === next) return;

  if (next === false) {
    // ON → OFF
    await markSeenOff();
    await emit(LOCKLESS_FUNNEL_STEPS.OFF);
    return;
  }

  // OFF → ON. 이전에 OFF 경험 있었으면 re_on, 아니면 on.
  const seenOff = await hasSeenOffOnce();
  await emit(
    seenOff ? LOCKLESS_FUNNEL_STEPS.RE_ON : LOCKLESS_FUNNEL_STEPS.ON,
  );
}
