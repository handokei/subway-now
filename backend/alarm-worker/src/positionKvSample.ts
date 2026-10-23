/**
 * #3006 PR-0 — POST /position KV write 샘플 계측 (관측 전용, 동작 변경 0, **KV 접근 추가 0**).
 *
 * 목적: /position 한 호출이 어떤 KV put(W1 `pos` / W2 `deviceContact` / W3·W4 `trip` / W5 `accel` /
 * W6 `ssot`)을 실제로 **시도**하는지를 lock 상태·appState별로 D1에서 직접 센다. 스로틀·skip 분기가
 * 많아 코드만 읽어서는 호출당 put 수를 확정할 수 없고(이슈 #3006 §2-0 "call 모델은 상한도 하한도
 * 아니다"), PR-3/5/6의 절감폭 측정 근거가 이 계측이다.
 *
 * 제약
 * - KV read/write를 추가하지 않는다. put은 얇은 래퍼가 key prefix만 기록하고 그대로 위임한다.
 *   적재는 D1 `trip_events`(kind=`position-kv-sample`)뿐이다.
 * - 1/20 샘플링(미당첨이면 래퍼조차 씌우지 않는다) + UTC 일 300행 상한(D1 COUNT, `d1KvLatencyProbe.ts` 패턴).
 * - 응답 이후 `waitUntil`에서 돌고 어떤 실패도 흡수한다.
 *
 * meta
 * - `stages`    : 이 호출이 시도한 KV put의 key prefix를 시도 순서대로(중복 포함). 실패한 put도 시도로 센다.
 * - `attempted` : `stages.length`.
 * - `lockState` : 'lock'(= `isBoardingLockActive`, 이슈 §1-0 LOCK) | 'lockless' | 'no-trip'(trip 키 없음) |
 *                 'unknown'(getTrip 실패).
 * - `appState`  : 'fg' | 'bg' | null(구버전 클라 미전송).
 * - `headKind`  : `trip.waypoints[0].kind`(다음 waypoint 종류). trip 없음/빈 waypoints면 null.
 * - `etaMissing`: `trip.consecutiveEtaMissing > 0`.
 * - `hasAccel`  : 요청에 유효한 accelSummary가 있었는지(W5 시도 조건).
 * - `pointLagMs`: 서버 now - point.ts(BG 큐잉 지연 지표).
 */
import { isBoardingLockActive } from './scheduled';
import { recordTripEvent } from './tripEventLog';
import type { Trip } from './types';

/** 마스터 스위치. false면 샘플링 자체가 일어나지 않는다. */
export const POSITION_KV_SAMPLE_ENABLED = true;

/** 샘플링 비율(1/20). */
export const POSITION_KV_SAMPLE_RATE = 0.05;

/** UTC 일 상한(행). */
export const POSITION_KV_SAMPLE_DAILY_CAP = 300;

/** trip_events.kind. */
export const POSITION_KV_SAMPLE_KIND = 'position-kv-sample';

const MS_PER_DAY = 24 * 60 * 60_000;
const KEY_PREFIX_SEPARATOR = ':';

export type PositionLockState = 'lock' | 'lockless' | 'no-trip' | 'unknown';

export interface PositionKvSampleMeta {
  stages: string[];
  attempted: number;
  lockState: PositionLockState;
  appState: 'fg' | 'bg' | null;
  headKind: string | null;
  etaMissing: boolean;
  hasAccel: boolean;
  pointLagMs: number;
}

/** `random`(0~1)이 샘플링 비율 미만이면 당첨. */
export function shouldSamplePositionKv(
  random: number,
  enabled: boolean = POSITION_KV_SAMPLE_ENABLED,
): boolean {
  return enabled && random < POSITION_KV_SAMPLE_RATE;
}

export interface PutRecorder {
  /** put만 기록하고 나머지는 원본 KV에 그대로 위임하는 래퍼. */
  kv: KVNamespace;
  /** 지금까지 시도된 put의 key prefix(시도 순서). */
  stages(): string[];
}

/**
 * KV 래퍼 — `put` 호출 시점에 key prefix를 기록한 뒤 원본에 위임한다(결과/예외 그대로 전달).
 * get/delete/list는 원본 그대로이므로 KV 접근이 늘지 않는다.
 */
export function createPutRecorder(kv: KVNamespace): PutRecorder {
  const stages: string[] = [];
  const wrapped = new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'put') {
        return (key: string, ...rest: unknown[]) => {
          stages.push(key.split(KEY_PREFIX_SEPARATOR)[0]);
          return (value as (...args: unknown[]) => unknown).call(target, key, ...rest);
        };
      }
      return value.bind(target);
    },
  });
  return { kv: wrapped, stages: () => [...stages] };
}

export function classifyLockState(trip: Trip | null | 'unknown', now: number): PositionLockState {
  if (trip === 'unknown') return 'unknown';
  if (trip === null) return 'no-trip';
  return isBoardingLockActive(trip, now) ? 'lock' : 'lockless';
}

export interface PositionKvSampleInput {
  stages: string[];
  trip: Trip | null | 'unknown';
  appState: 'fg' | 'bg' | undefined;
  hasAccel: boolean;
  pointTs: number;
  now: number;
}

export function buildPositionKvSampleMeta(input: PositionKvSampleInput): PositionKvSampleMeta {
  const { stages, trip, appState, hasAccel, pointTs, now } = input;
  const tripObj = trip === 'unknown' || trip === null ? null : trip;
  const [head] = tripObj?.waypoints ?? [];
  return {
    stages,
    attempted: stages.length,
    lockState: classifyLockState(trip, now),
    appState: appState ?? null,
    headKind: head?.kind ?? null,
    etaMissing: (tripObj?.consecutiveEtaMissing ?? 0) > 0,
    hasAccel,
    pointLagMs: now - pointTs,
  };
}

/**
 * 오늘(UTC) 샘플 행이 상한 미만일 때만 `trip_events`에 1행 적재한다. DB 미바인딩/조회 실패/적재 실패는
 * 모두 흡수한다(관측 전용).
 */
export async function recordPositionKvSample(
  db: D1Database | undefined,
  tokenHash: string,
  meta: PositionKvSampleMeta,
  now: number,
): Promise<void> {
  if (!db) return;
  try {
    const dayStart = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM trip_events WHERE kind = ? AND ts >= ?')
      .bind(POSITION_KV_SAMPLE_KIND, dayStart)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= POSITION_KV_SAMPLE_DAILY_CAP) return;
  } catch {
    return;
  }
  await recordTripEvent(db, { tokenHash, kind: POSITION_KV_SAMPLE_KIND, meta }, now);
}
