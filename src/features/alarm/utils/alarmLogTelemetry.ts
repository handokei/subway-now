/**
 * Trip 종료 시점에 매역 알림 recall KPI 를 계산하고 backend 에 upload 하는 wiring (#919).
 *
 * 사용 패턴:
 *   await computeAndUploadTripRecall({ routeStops, tripStart, tripEnd });
 *
 * 호출자(silent push trip-ended handler, FG setDestination(null) 등)는 trip 종료가
 * 결정된 시점에 본 함수를 fire-and-forget 으로 호출한다. 본 함수는 모든 에러를
 * 흡수해 호출자 흐름을 절대 차단하지 않는다 (graceful).
 *
 * 동작 변경 없음 — 순수 측정. APNs token 미발급/recall 신호 0/backend 실패 모두
 * 조용히 skip 한다. 실제 trip-end 경로 wiring 은 별도 PR.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import { getAlarmLog, type AlarmLogEntry } from './alarmLog';
import {
  computeTripRecall,
  isEmptyRecall,
  type TripRecallResult,
} from './recallMetrics';
import {
  computePrescheduledMetrics,
  isEmptyPrescheduledMetrics,
  type PrescheduledMetricsResult,
} from './prescheduledMetrics';
import {
  uploadPrescheduledTelemetry,
  uploadRecallTelemetry,
} from '../api/telemetryBackend';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('alarmLogTelemetry');

export interface ComputeAndUploadTripRecallInput {
  /** route 의 역 이름 배열 (해당 trip 의 정차역 전체). */
  routeStops: readonly string[];
  /** trip 시작 epoch ms — alarmLog 윈도우 필터 lower bound. */
  tripStart: number;
  /** trip 종료 epoch ms — alarmLog 윈도우 필터 upper bound (default now). */
  tripEnd?: number;
}

export type ComputeAndUploadSkipReason = 'no-token' | 'empty' | 'error';

export interface ComputeAndUploadTripRecallResult {
  uploaded: boolean;
  /** uploaded=false 일 때 사유. uploaded=true 면 undefined. */
  skipped?: ComputeAndUploadSkipReason;
  /** 계산된 recall payload — 디버그/추후 로컬 표기용. error 시 undefined. */
  recall?: TripRecallResult;
}

export async function computeAndUploadTripRecall(
  input: ComputeAndUploadTripRecallInput,
): Promise<ComputeAndUploadTripRecallResult> {
  try {
    const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
    if (!token) {
      log.info('no APNs token — skip recall upload');
      return { uploaded: false, skipped: 'no-token' };
    }

    const entries = await getAlarmLog();
    const recall = computeTripRecall({
      routeStops: input.routeStops,
      entries,
      tripStart: input.tripStart,
      tripEnd: input.tripEnd ?? Date.now(),
    });

    if (isEmptyRecall(recall)) {
      return { uploaded: false, skipped: 'empty', recall };
    }

    const result = await uploadRecallTelemetry(token, recall);
    return { uploaded: result.ok, recall };
  } catch (e) {
    log.warn('recall upload error', e);
    return { uploaded: false, skipped: 'error' };
  }
}

export interface ComputeAndUploadTripPrescheduledInput {
  /** trip 시작 epoch ms — ledger 필터 lower bound. */
  tripStart: number;
  /** trip 종료 epoch ms — ledger 필터 upper bound (default now). */
  tripEnd?: number;
}

export interface ComputeAndUploadTripPrescheduledResult {
  uploaded: boolean;
  skipped?: ComputeAndUploadSkipReason;
  metrics?: PrescheduledMetricsResult;
}

/**
 * A3 사전 예약 효과 텔레메트리 trip-end trigger (#918, Epic #912 P1).
 *
 * `computeAndUploadTripRecall`과 동형 — APNs token이 없거나 ledger가 비어있으면 graceful skip.
 * alarmLog는 한 번만 읽어 fired stationName 집합을 만들고 prescheduledMetrics에 전달
 * (recall + prescheduled 양쪽 모두 alarmLog 의존이지만 caller가 각각 호출하므로 두 번 읽힘 —
 * trip-end는 자주 일어나지 않아 비용 무시 가능).
 */
export async function computeAndUploadTripPrescheduled(
  input: ComputeAndUploadTripPrescheduledInput,
): Promise<ComputeAndUploadTripPrescheduledResult> {
  try {
    const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
    if (!token) {
      log.info('no APNs token — skip prescheduled upload');
      return { uploaded: false, skipped: 'no-token' };
    }

    const entries = await getAlarmLog();
    const tripEnd = input.tripEnd ?? Date.now();
    const firedStationNames = collectFiredStationNames(entries, input.tripStart, tripEnd);
    const metrics = await computePrescheduledMetrics({
      tripStart: input.tripStart,
      tripEnd,
      firedStationNames,
    });

    if (isEmptyPrescheduledMetrics(metrics)) {
      return { uploaded: false, skipped: 'empty', metrics };
    }

    const result = await uploadPrescheduledTelemetry(token, metrics);
    return { uploaded: result.ok, metrics };
  } catch (e) {
    log.warn('prescheduled upload error', e);
    return { uploaded: false, skipped: 'error' };
  }
}

/**
 * 윈도우 안 fired outcome entry에서 stationName 집합을 추출. prescheduledMetrics의 정확도 분자
 * 산출에 사용. recallMetrics는 routeStops ∩ fired를 보는 반면 prescheduled는 ledger identifier에서
 * 파싱한 station을 cross-key로 한다.
 */
function collectFiredStationNames(
  entries: readonly AlarmLogEntry[],
  tripStart: number,
  tripEnd: number,
): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.ts <= tripStart || entry.ts > tripEnd) continue;
    if (entry.outcome !== 'fired') continue;
    if (entry.stationName) out.add(entry.stationName);
  }
  return out;
}
