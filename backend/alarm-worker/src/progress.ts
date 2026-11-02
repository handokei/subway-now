/**
 * Trip waypoint advance progress — POST /trips race로부터 격리된 별도 KV 키 (#705).
 *
 * 배경:
 *   Trip 객체에 `waypoints`가 직접 포함되어 있어, 디바이스가 cold restart 후 동일
 *   trip을 재등록하면 backend가 advance해둔 waypoints가 wipe되는 race가 존재했다
 *   (#704는 isSameSession 강화로 같은 trainCode면 보존하지만, 진정한 격리는 advance
 *   상태를 trip 객체 밖으로 빼야 가능).
 *
 * 설계:
 *   - 키: `progress:<token>` (TRIPS KV 재사용 — 새 namespace 도입 비용 회피)
 *   - 값: shiftedCount + 추적 baseline. trainCode를 stamp해 다른 열차로 갈아탄
 *         새 세션이면 fresh start로 동작.
 *   - #2308 (ADR-052) — 작성자는 cron 경로 `mirrorProgress` 하나다. POST /trips·/boarding-lock/sync는
 *     progress를 쓰지 않고, register는 읽지도 적용·삭제도 하지 않는다(세션 경계에서만 삭제).
 *     대신 cron이 매 tick `reconcileTripWithProgress`로 trip.waypoints(노선 정의 사본)를 progress head까지
 *     앞으로만 맞춘다. 이 파일의 설계가 풀려던 race("진정한 격리")를 그렇게 완결한다.
 *   - runTrainCodeTracking: 성공/실패 사이클에서 baseline(consecutiveEtaMissing,
 *     lastTrackedArrivalEpoch, lastLaPushEpoch)도 progress에 mirror하고, 맞춤이 trip으로 복원한다.
 */

import { assertKvCacheTtl } from './kvConsistency';
import { waypointSignatureKey } from './trips';
import type { Trip } from './types';

const PROGRESS_PREFIX = 'progress:';

export interface TripProgress {
  /** trainCode stamp. POST 시 incoming lock과 비교해 다른 열차면 progress 폐기.
   *  lockless trip은 trainCode 없이 token 기준으로만 매칭 — undefined 허용. */
  trainCode?: string;
  /** #1285 — lockless opt-in trip 진행 보존 마커. trainCode 없이 token 기준으로 progress를 유지한다. */
  lockless?: true;
  /** advance로 shift한 waypoint 개수. POST의 incoming.waypoints에 slice(shiftedCount) 적용. */
  shiftedCount: number;
  /**
   * advance 시점 head waypoint의 `hopIndex` — 하위호환 기록만(읽는 곳 0). device 재등록 waypoints에는 hopIndex가 없어
   * backend `validateTrip`이 배열 위치로 다시 매기므로 head 식별자로 쓸 수 없다(#2308 재오픈, `headKey` 참고).
   */
  headHopIndex?: number;
  /**
   * #2308 — head waypoint의 내용 키(`waypointSignatureKey`). device 재등록 waypoints에는 hopIndex가 없어 backend `validateTrip`이
   * 배열 위치로 다시 매기므로 hopIndex는 head 식별자로 쓸 수 없다. cron 맞춤(`reconcileTripWithProgress`)이 이 키로
   * trip.waypoints에서 head를 찾아 앞으로만 자른다. 구 progress(필드 없음)는 맞춤 대상이 아니다.
   */
  headKey?: string;
  /** Trip의 lastTrackedArrivalEpoch 사본 — race-isolated. */
  lastTrackedArrivalEpoch?: number;
  /** Trip의 lastLaPushEpoch 사본. */
  lastLaPushEpoch?: number;
  /** Trip의 lastLaPushAt(wall-clock) 사본 — #900 heartbeat 게이트 기준점. */
  lastLaPushAt?: number;
  /** Trip의 consecutiveEtaMissing 사본. */
  consecutiveEtaMissing?: number;
  /**
   * #3169 — 이 값을 쓸 때 KV TTL 산정에 쓴 `trip.expiresAt`. write-on-change 가드(`isProgressWriteRedundant`)가
   * "값 동일 + 만료 미연장"일 때만 put을 생략하도록 하는 기준점이다. trip.expiresAt이 이 값보다
   * 커지면(sliding 연장) progress 키가 trip보다 먼저 만료되지 않게 재기록한다. legacy 값(필드 없음)은
   * 1회 재기록되어 필드를 얻는다.
   */
  ttlBasisExpiresAt?: number;
}

export function progressKey(token: string): string {
  return `${PROGRESS_PREFIX}${token}`;
}

/**
 * caller가 KV `cacheTtl`을 지정하기 위한 옵션.
 * cron path는 cacheTtl=30s를 명시해 PUT 직후 stale read를 방지한다 (#766/#770).
 * POST handler는 인자 없이 호출 — 기본 cacheTtl(60s)이 적용된다.
 * #1423 — `cacheTtl < 30`은 `assertKvCacheTtl`이 caller 단계에서 RangeError throw.
 */
export interface GetProgressOptions {
  cacheTtl?: number;
}

export async function getProgress(
  kv: KVNamespace,
  token: string,
  options?: GetProgressOptions,
): Promise<TripProgress | null> {
  // #1423 — caller가 cacheTtl 명시했으면 floor 검증.
  assertKvCacheTtl(options?.cacheTtl);
  const raw = await kv.get(progressKey(token), options);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TripProgress;
    // lockless progress: lockless===true, trainCode 없음. lock progress: trainCode 문자열 필수.
    const validTrainCode = typeof parsed.trainCode === 'string';
    const validLockless = parsed.lockless === true && parsed.trainCode === undefined;
    if ((!validTrainCode && !validLockless) || typeof parsed.shiftedCount !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * #3169 — cron의 매 tick progress put 중복 생략 판정.
 * 생략 조건(전부 충족): ① 기존 값 존재 ② 기존 값에 TTL basis 기록됨(legacy 아님)
 * ③ basis 외 모든 필드 동일 ④ 새 만료가 기존 basis를 넘지 않음(연장 없음 → 기존 TTL로 충분).
 *
 * stale-read 안전성: 비교 대상 `existing`이 cacheTtl(30s) 때문에 최신이 아닐 수 있다. 이 가드는
 * "cron이 계산한 값 == 읽은 값"일 때 **쓰지 않는** 방향으로만 작동하므로, stale 읽기가 만들 수 있는
 * 최악은 (a) 실제 최신값이 읽은 값과 달라 cron 값이 최신과 다른데도 생략 — 이때 KV에 남는 것은
 * HTTP 경로(sync/POST)가 더 늦게 쓴 값이며 기존 무조건-put은 오히려 그 최신값을 cron의 stale 파생값으로
 * 덮어썼다(회귀 경로), (b) 불필요한 재기록 — 무해. 어느 쪽도 오래된 값을 새로 남기지 않는다.
 */
export function isProgressWriteRedundant(
  existing: TripProgress | null,
  next: TripProgress,
): boolean {
  if (existing === null) return false;
  const { ttlBasisExpiresAt: prevBasis, ...prevRest } = existing;
  const { ttlBasisExpiresAt: nextBasis, ...nextRest } = next;
  if (prevBasis === undefined || nextBasis === undefined || nextBasis > prevBasis) return false;
  const keys = new Set([...Object.keys(prevRest), ...Object.keys(nextRest)]);
  for (const key of keys) {
    if (prevRest[key as keyof typeof prevRest] !== nextRest[key as keyof typeof nextRest]) {
      return false;
    }
  }
  return true;
}

export async function putProgress(
  kv: KVNamespace,
  token: string,
  progress: TripProgress,
  ttlSec: number,
): Promise<void> {
  await kv.put(progressKey(token), JSON.stringify(progress), {
    expirationTtl: Math.max(60, Math.floor(ttlSec)),
  });
}

export async function deleteProgress(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(progressKey(token));
}

/** 맞춤이 덮는 LA·추적 기준값 집합(옛 register `applyProgress`와 같은 집합). */
export interface ProgressBaseline {
  lastTrackedArrivalEpoch?: number;
  lastLaPushEpoch?: number;
  lastLaPushAt?: number;
  consecutiveEtaMissing?: number;
}

export interface ReconcileDecision {
  /** 맞춤 이후 waypoints (advancedBy===0이면 원본 그대로). */
  waypoints: Trip['waypoints'];
  /** 앞으로 자른 개수(0 = head 일치, 기준값만 덮는다). */
  advancedBy: number;
  /** 자르기 전 head 키 / 맞춘 head 키 (D1 마커용). */
  fromKey: string;
  toKey: string;
  baseline: ProgressBaseline;
}

/**
 * #2308 — cron 맞춤. progress KV가 진행 위치의 권위이고 trip.waypoints는 노선 정의 사본이다.
 * lock 활성 trip에서 progress.trainCode==lock.trainCode이고 progress.headKey가 trip.waypoints[i]에 있으면:
 *  - i>0: 앞으로 slice(i) (뒤로 가지 않는다)
 *  - i=0: 자르지 않음
 * 두 경우 모두 기준값(LA·추적)을 progress 값으로 덮는다. 못 찾으면(trip이 progress보다 앞섬/다른 노선)·legacy(headKey 없음)·
 * lockless progress·trainCode 불일치는 null — 추측 slice 금지. 순수 함수(입력 불변).
 */
export function reconcileTripWithProgress(trip: Trip, progress: TripProgress | null): ReconcileDecision | null {
  const trainCode = trip.boardingLock?.trainCode;
  if (progress === null || trainCode === undefined) return null;
  const { headKey } = progress;
  if (progress.trainCode !== trainCode || headKey === undefined) return null;
  const index = trip.waypoints.findIndex((w) => waypointSignatureKey(w) === headKey);
  if (index < 0) return null;
  const { lastTrackedArrivalEpoch, lastLaPushEpoch, lastLaPushAt, consecutiveEtaMissing } = progress;
  return {
    waypoints: index === 0 ? trip.waypoints : trip.waypoints.slice(index),
    advancedBy: index,
    fromKey: waypointSignatureKey(trip.waypoints[0]),
    toKey: headKey,
    baseline: { lastTrackedArrivalEpoch, lastLaPushEpoch, lastLaPushAt, consecutiveEtaMissing },
  };
}
