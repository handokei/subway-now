/**
 * Pull 기반 trip 死 backstop (#2178, Part of #2172).
 *
 * 배경: trip 사망 통보는 push 단일 채널(trip-ended sentinel)인데, 사망 사유가 APNs 토큰
 * 무효면 그 push 자체가 도달 불가(닭-달걀). launch reconciliation(#1339)은 cold-launch
 * 시점에만 동작 — BG 중 사망은 다음 FG 진입까지 인지되지 않는다. 08-06 evidence: 18:11 死를
 * 20:19 FG까지 미인지, 그 사이 로컬 OS 예약 큐가 주인 없는 조기 묶음발사(어대공/군자/중곡/용마산).
 *
 * 전제(#2175): backend GET `/trips/:tripToken/status`가 로테이션 발생 시에도 실토큰 기준으로
 * 해소돼야 안전 — 그 전엔 로테이션 직후 정상 trip을 404로 오판해 죽일 위험이 있었다(이슈
 * #2178 코멘트). #2175가 머지·배포된 뒤에만 본 모듈을 사용한다.
 *
 * 보수적 death 판정 (ADR-010 — false positive는 miss와 동급, 오탐으로 trip을 죽이지 않는다):
 *   - status === 'ended' (명시 응답)만 death 확정 → cleanup 수행.
 *   - null(404/410) / status === 'active' / 네트워크 에러 → 전부 무동작.
 *
 * 두 진입점이 공유:
 *   1. silentPushTask 처리 말미 — 로컬 active trip이 있는데 수신 payload의 trip 신원과
 *      불일치하거나, 마지막 backend 접촉이 TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS 이상이면 호출.
 *   2. backgroundLocationTask — 신규 폴링/타이머 없이 기존 BG location tick에 편승, 같은
 *      상수를 호출 쿨다운으로 사용(V8 battery acceptance).
 *
 * death 확정 시: OS 예약 큐 cancel + launch reconciliation과 동일 cleanup 시퀀스
 * (tripEndedCleanupSequence, 중복 구현 금지) + alarmLog `trip-dead-pull-detected` 기록.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACTIVE_TRIP_KEY,
  TRIP_DEATH_PULL_LAST_CHECK_AT_KEY,
} from '../../../shared/constants/storageKeys';
import { TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS } from '../../../shared/constants/realtime';
import { fetchTripStatus } from '../api/tripStatus';
import { cancelTripBoundOsQueue } from '../store/tripBoundCleanups';
import { cleanupBackendConfirmedEndedTrip } from './tripEndedCleanupSequence';
import { appendAlarmLog } from './alarmLog';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('tripDeathPullBackstop');

/** `EXPO_PUBLIC_ALARM_BACKEND_URL` trim. 미설정 시 null — 호출자는 graceful skip 처리. */
export function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function readLastCheckedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_DEATH_PULL_LAST_CHECK_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function stampCheckedAt(now: number): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_DEATH_PULL_LAST_CHECK_AT_KEY, String(now));
  } catch {
    // graceful — 쿨다운 미기록이면 다음 wake에서 재시도할 뿐, death 판정 자체는 안전.
  }
}

/**
 * silentPushTask 진입점 트리거 조건 (스펙 1) — 순수 함수, 테스트 용이성을 위해 분리.
 *
 * 로컬 active trip이 있고, (a) 수신 payload가 trip 신원(tripToken)을 담고 있는데 로컬
 * ACTIVE_TRIP_KEY와 불일치하거나, (b) 마지막 backend 접촉(직전 silent push 수신 시각)이
 * threshold 이상 지났으면 true.
 */
export function shouldCheckTripDeathOnSilentPush(input: {
  activeTripToken: string | null;
  payloadTripToken: string | undefined;
  priorLastReceivedAt: number | null;
  now: number;
}): boolean {
  if (input.activeTripToken === null) return false;
  const identityMismatch =
    input.payloadTripToken !== undefined && input.payloadTripToken !== input.activeTripToken;
  const contactStale =
    input.priorLastReceivedAt !== null &&
    input.now - input.priorLastReceivedAt >= TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS;
  return identityMismatch || contactStale;
}

export type TripDeathPullCheckSite = 'silent-push' | 'bg-location-tick';
export type TripDeathPullCheckOutcome = 'ended' | 'alive' | 'skipped';

/**
 * pull 기반 death 확인 1회 시도.
 *
 * - active trip 없으면 즉시 skip.
 * - 쿨다운(TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS) 내 재호출은 skip — 호출 시도 자체를
 *   기록해 실패(네트워크 에러) 반복 재시도로 인한 hot-loop도 함께 방지한다.
 * - status==='ended' 명시 응답에서만 death 확정 → cleanup. 그 외(404/410/active/네트워크
 *   에러)는 전부 무동작(false positive 방지, ADR-010).
 */
export async function checkTripDeathByPull(
  baseUrl: string,
  site: TripDeathPullCheckSite,
): Promise<TripDeathPullCheckOutcome> {
  const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (activeTripToken === null) return 'skipped';

  const now = Date.now();
  const lastCheckedAt = await readLastCheckedAt();
  if (lastCheckedAt !== null && now - lastCheckedAt < TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS) {
    return 'skipped';
  }
  await stampCheckedAt(now);

  let result;
  try {
    result = await fetchTripStatus(activeTripToken, baseUrl);
  } catch (e) {
    logger.warn(`fetchTripStatus 실패 (site=${site}) — 무동작(다음 wake에서 재시도)`, e);
    return 'skipped';
  }

  if (result === null || result.status === 'active') {
    // 404/410은 보수적으로 무시 — 'ended' 명시 응답에서만 정리(#2178 전제 코멘트, ADR-010).
    return 'alive';
  }

  // status === 'ended' — death 확정.
  logger.info(
    `trip dead confirmed via pull (site=${site}) reason=${result.endReason ?? 'unknown'}`,
  );
  // #1370 L4 — OS scheduled queue burst fire 차단(lesson_bg_scheduled_queue_stale_misfire).
  // runTripBoundCleanups가 결국 cancel하지만, recall의 네트워크 stall로 열리는 race window를
  // silentPushTask trip-ended 분기와 동일하게 선제 cancel로 좁힌다.
  await cancelTripBoundOsQueue();
  await cleanupBackendConfirmedEndedTrip(result.endedAt ?? now);
  appendAlarmLog({
    ts: now,
    source: 'lifecycle-backstop',
    outcome: 'fired',
    reason: 'trip-dead-pull-detected',
  });
  return 'ended';
}
