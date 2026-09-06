/* eslint-disable import/no-restricted-paths --
 * #1503 (M3 Sub C wire) — boardable train timetable lookup 결과를 alarmLog ring buffer로 stamp
 * 한다. forward chain: device alarmLog → R2 archive(trip 종료 시) → backend alarmLogStats →
 * observabilityMetrics.boardableMissRatio → /v1/observability/metrics → DebugModal Operation
 * Dashboard Metric 4. 다른 cross-feature 적재 사이트(useAccelerometerFingerprint, useBoarding-
 * LockAutoRelease 등)와 같은 패턴.
 */
import type { Route, TransferSegment } from '../../../shared/utils/stationRoute';
import { getTransferSeconds } from '../../../shared/utils/transferTimes';
import { resolveTravelDirection } from './travelDirection';
import {
  calculateBoardableTrainETA,
  decideBufferSeconds,
} from './calculateBoardableTrainETA';
import type { LineNumber } from '../../../shared/types/station';
import { logBoardableLookupResult } from '../../alarm/utils/alarmLog';

/**
 * 환승 leg별 boardable train 대기 시간(초) 리스트를 산출 (#1480).
 *
 * `stationRoute.calculateStaticETA`의 `timetableBoardableWaitSecondsByLeg` 옵션에 직접 주입.
 * 실시간 arrival 정보가 없는 trip(예: production silent push 인입 전 또는 막차 직후)에서
 * 환승 후 다음 열차 대기를 실측 시간표 기반으로 보강.
 *
 * 결과는 transfers 순서. element가 `null`이면 다음 fallback (`DEFAULT_WAIT_MINUTES`).
 */

const SECONDS_PER_MINUTE = 60;

export interface RouteBoardableWaitParams {
  route: Route;
  /** 출발 trip 시작 기준 시각 (now). */
  startAt: Date;
  /**
   * 출발역 → 첫 환승역까지 걸리는 시간(초). 호출자가 실시간 arrival을 받았다면 거기서 산출,
   * 아니면 stationRoute가 가진 정적 segment 시간 활용.
   */
  initialWaitSeconds: number;
  /**
   * 최종 도착역 이름 — 마지막 leg direction inference 보강.
   * 미지정 시 마지막 leg는 direction inference 실패로 null 반환 (호출자 cascade가 DEFAULT 적용).
   */
  destinationName?: string;
}

/**
 * 결과 element 의미:
 *   - number: timetable lookup 성공 (waitSeconds = boardable departure - effectiveArrival)
 *   - null:   timetable 부재(1~9호선 외) / station alias 불일치 / dayType 불명 / 막차+첫차 모두 미존재
 *
 * 호출자(예: `calculateStaticETA`)는 null이면 `DEFAULT_WAIT_MINUTES` fallback.
 */
export function computeBoardableWaitsForRoute(
  params: RouteBoardableWaitParams,
): Array<number | null> {
  const { route, startAt, initialWaitSeconds, destinationName } = params;
  if (!route || route.type === 'direct') return [];

  const segments = collectTransferSegments(route, destinationName);
  /* istanbul ignore if -- 위 if !route || route.type === 'direct'에서 이미 빈 경로를 걸러, transfer/
     multi-transfer는 collectTransferSegments가 최소 1개 segment 반환. 안전망. */
  if (segments.length === 0) return [];

  const result: Array<number | null> = [];
  // 환승역 도착 시각은 (이전 leg 끝 시각 + 환승 도보 시간). 누적해서 진행.
  let cursorSeconds = initialWaitSeconds;

  for (const segment of segments) {
    const cumulativeArrivalAt = new Date(
      startAt.getTime() + cursorSeconds * 1000 + segment.secondsToTransfer * 1000,
    );
    const transferWalkingSeconds = getTransferSeconds(
      segment.fromLine,
      segment.toLine,
      segment.transferName,
    );
    const bufferSeconds = decideBufferSeconds(transferWalkingSeconds);

    const direction = resolveTravelDirection(
      segment.toLine,
      segment.transferName,
      segment.nextEndName,
    )?.direction ?? null;

    if (direction === null) {
      // 단조 노선 화이트리스트(2호선 순환 등) 밖이면 boardable lookup 불가 → 다음 fallback.
      // #1503 — direction inference 실패 = miss (timetable이 있어도 단조 가정 못함).
      logBoardableLookupResult({
        status: 'miss',
        line: segment.toLine,
        stationName: segment.transferName,
      });
      result.push(null);
      // 다음 leg 계산을 위해 도착 시각만 갱신 — boardable wait는 모름.
      cursorSeconds +=
        segment.secondsToTransfer + transferWalkingSeconds + bufferSeconds;
      continue;
    }

    const lookup = calculateBoardableTrainETA({
      arrivalAt: cumulativeArrivalAt,
      bufferSeconds: bufferSeconds + transferWalkingSeconds,
      nextLeg: {
        stationName: segment.transferName,
        line: segment.toLine,
        direction,
      },
    });

    // #1503 — telemetry stamp: status='ok' → received, 그 외(no-timetable / station-missing /
    // day-type-unknown / no-departures) → suppressed. backend alarmLogStats가 boardableLookup-
    // Counts 누적, observabilityMetrics.boardableMissRatio = miss / (ok + miss).
    logBoardableLookupResult({
      status: lookup.status === 'ok' ? 'ok' : 'miss',
      line: segment.toLine,
      stationName: segment.transferName,
    });

    if (lookup.status === 'ok') {
      const waitSeconds = lookup.departure.waitSeconds;
      result.push(waitSeconds);
      cursorSeconds +=
        segment.secondsToTransfer +
        transferWalkingSeconds +
        bufferSeconds +
        waitSeconds;
    } else {
      result.push(null);
      cursorSeconds +=
        segment.secondsToTransfer + transferWalkingSeconds + bufferSeconds;
    }
  }

  return result;
}

interface TransferLegContext {
  /** 이전 leg 노선. */
  fromLine: LineNumber;
  /** 다음 leg 노선. */
  toLine: LineNumber;
  /** 환승역 이름 (fromLine 측 표기). */
  transferName: string;
  /** 이전 leg에서 본 환승역까지 운행 시간(초). */
  secondsToTransfer: number;
  /** 다음 leg의 종착(=다음 환승역 or 최종 목적지) 이름 — direction inference 용. */
  nextEndName: string;
}

function collectTransferSegments(
  route: NonNullable<Route>,
  destinationName: string | undefined,
): TransferLegContext[] {
  /* istanbul ignore if -- caller(computeBoardableWaitsForRoute)가 direct를 미리 걸러 호출하지 않는다.
     TS narrowing을 위한 안전망. */
  if (route.type === 'direct') return [];
  if (route.type === 'transfer') {
    // 단일 환승 — destinationName이 주어지면 direction inference 가능. 미지정 시 transferName으로
    // 두면 resolveTravelDirection이 fromIdx === toIdx로 null 반환 → 호출자 cascade가 처리.
    return [
      {
        fromLine: route.fromLine,
        toLine: route.toLine,
        transferName: route.transferName,
        secondsToTransfer: route.secondsToTransfer,
        nextEndName: destinationName ?? route.transferName,
      },
    ];
  }

  // multi-transfer — transfers 배열 순회. 각 leg의 nextEndName은 다음 transfer의 transferName.
  // 마지막 leg는 destinationName 활용 (없으면 transferName fallback).
  const segments: TransferLegContext[] = [];
  const { transfers } = route;
  for (let i = 0; i < transfers.length; i++) {
    const current = transfers[i];
    const nextEndName = computeNextEndName(transfers, i, destinationName);
    segments.push({
      fromLine: current.fromLine,
      toLine: current.toLine,
      transferName: current.transferName,
      secondsToTransfer: current.secondsToTransfer,
      nextEndName,
    });
  }
  return segments;
}

function computeNextEndName(
  transfers: readonly TransferSegment[],
  currentIdx: number,
  destinationName: string | undefined,
): string {
  const next = transfers[currentIdx + 1];
  if (next) return next.transferName;
  // 마지막 환승 — 다음 leg는 최종 도착역까지. destinationName이 있으면 사용, 없으면 transferName
  // fallback (resolveTravelDirection이 fromIdx === toIdx로 null 반환, 호출자 cascade 처리).
  return destinationName ?? transfers[currentIdx].transferName;
}

/** 분 단위 helper — calculateStaticETA에 직접 주입할 때 디버깅용 표시. */
export function totalBoardableWaitMinutes(
  waitSecondsList: ReadonlyArray<number | null>,
): number {
  let total = 0;
  for (const seconds of waitSecondsList) {
    if (seconds === null) continue;
    total += seconds / SECONDS_PER_MINUTE;
  }
  return total;
}
