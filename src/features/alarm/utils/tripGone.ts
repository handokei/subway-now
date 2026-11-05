/**
 * B 최소판(PR-2) — backend 404/410(트립 없음)을 device 자가 종료의 증거로 인정할지 판정한다.
 *
 * 404는 한 가지 원인이 아니다(plan §2.4): KV TTL 만료(= 진짜 종료, 목표) / 방금 등록·KV 전파 지연 /
 * 사용자·타 경로 삭제 / 로테이션 / 마커 TTL 경과(410). "404 = 죽었다"로 읽으면 살아있는 트립을 죽인다
 * (ADR-010: false positive는 miss와 동급) — 그래서 4 guard 전부 AND:
 *   1. 하한: `now > 시작 + 2h + GRACE`. 서버 expiresAt은 시작+2h 아래로 내려가지 않으므로(PR #3125) 그 이전
 *      404는 전파 지연이다. 시작 시각이 없으면 하한을 계산할 수 없어 young으로 본다.
 *   2. 판별 gone(404/410). 그 외 응답은 판정 대상이 아니다.
 *   3. 미만료 BoardingLock 없음 — 사용자 명시 의향 trip은 9h force-end 등 기존 경로에 위임. **만료된 lock은
 *      차단하지 못한다**(영구 차단 방지). `getBoardingLock()`은 만료를 검사하지 않으므로 반드시 만료 판정을 거친다.
 *   4. 이 트립의 대기 중 도착(destination) OS 알람 없음 — 종료가 유일한 도착 안전망을 죽이면 miss.
 *
 * 순수 함수 — 입력 수집(스토리지·OS 조회)은 호출부(`tripGoneSelfEnd`).
 */
import * as Notifications from 'expo-notifications';
import { TRIP_GONE_GRACE_MS } from '../../../shared/constants/realtime';
import { isBoardingLockExpired, type BoardingLock } from '../../../shared/types/boardingLock';
import { DEFAULT_TRIP_TTL_MS } from '../api/alarmBackend';
import type { TripStatusFetchResult } from '../api/tripStatus';
import { SAFETY_NET_ALARM_PREFIX } from './safetyNetScheduler';
import { PRESCHED_ALARM_PREFIX } from './stationPrescheduler';

/** 유예 사유 — 알람 로그/테스트가 assert한다. */
export type TripGoneDeferReason = 'young' | 'lock' | 'alarm';

export type TripGoneVerdict =
  | { verdict: 'end' }
  | { verdict: 'defer'; reason: TripGoneDeferReason }
  | { verdict: 'not-gone' };

export interface TripGoneInput {
  result: TripStatusFetchResult;
  now: number;
  /** `TRIP_STARTED_AT`. 없으면 하한을 계산할 수 없다. */
  tripStartedAt: number | null;
  lock: BoardingLock | null;
  hasFutureArrivalAlarm: boolean;
}

export function decideTripGone(input: TripGoneInput): TripGoneVerdict {
  const { result, now, tripStartedAt, lock, hasFutureArrivalAlarm } = input;
  if (result.status !== 'gone') return { verdict: 'not-gone' };
  const bound = tripStartedAt === null ? null : tripStartedAt + DEFAULT_TRIP_TTL_MS + TRIP_GONE_GRACE_MS;
  if (bound === null || now <= bound) return { verdict: 'defer', reason: 'young' };
  if (lock !== null && !isBoardingLockExpired(lock, now)) return { verdict: 'defer', reason: 'lock' };
  if (hasFutureArrivalAlarm) return { verdict: 'defer', reason: 'alarm' };
  return { verdict: 'end' };
}

/**
 * 이 트립의 **대기 중**(아직 발사 전) destination OS 알람이 있는가. 발사된 알람은 pending 큐에서 빠지므로
 * 별도 시각 비교는 필요 없다. 조회 실패는 fail-closed(true) — 확인하지 못하면 종료하지 않는다.
 * 식별은 취소 경로(`cancelAllSafetyNetAlarms` / `cancelAllPrescheduledAlarms`)와 같은 접두 규칙이다.
 */
export async function hasFutureTripArrivalAlarm(tripToken: string): Promise<boolean> {
  const prefixes = [
    `${SAFETY_NET_ALARM_PREFIX}${tripToken}-`,
    `${PRESCHED_ALARM_PREFIX}${tripToken.slice(0, 16)}-`,
  ];
  try {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    return pending.some((req) => {
      if (!prefixes.some((prefix) => req.identifier.startsWith(prefix))) return false;
      const { kind } = (req.content.data ?? {}) as { kind?: unknown };
      return kind === 'destination';
    });
  } catch {
    return true;
  }
}
