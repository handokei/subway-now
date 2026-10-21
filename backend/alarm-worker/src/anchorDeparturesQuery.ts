/**
 * #3155 — self-poll stamp(`realtime-position:<line>`)를 읽어 앵커역 출발 목록/관측 여부를 답하는 KV 어댑터.
 * 순수 판정은 `anchorDepartures.ts`. KV 장애는 "근거 없음"으로 degrade한다(기존 동작 유지, 새 거부/승격 없음).
 */
import {
  anchorFromSegment,
  classifyAnchorSighting,
  departedFromStation,
  resolveListAnchor,
} from './anchorDepartures';
import { readSelfPollPosition } from './selfPollPosition';
import type { LineNumber, Trip } from './types';

export interface AnchorDepartureRow {
  trainCode: string;
  departedAt: number;
  /** 그 열차가 지금 있는 역(피드에 없으면 null). */
  currentStation: string | null;
}

export interface AnchorDeparturesView {
  station: string;
  line: string;
  departed: AnchorDepartureRow[];
}

/**
 * 수동 탭(sync) corroboration 보강 — backend가 이 코드를 앵커역에서 직접 봤는가(접근 중 / 정차 / 10분 내 출발).
 * `segmentStations`는 승격 lock의 [관측역, 다음역...] 구간이다.
 */
export async function isTrainSeenAtAnchor(
  kv: KVNamespace,
  trainCode: string,
  line: string,
  segmentStations: readonly string[],
  now: number,
): Promise<boolean> {
  const anchor = anchorFromSegment(line, segmentStations);
  if (!anchor) return false;
  try {
    const stamp = await readSelfPollPosition(kv, line as LineNumber);
    if (!stamp) return false;
    return classifyAnchorSighting(trainCode, anchor, stamp.positions, stamp.stationLogs, now) !== null;
  } catch {
    return false;
  }
}

/** 목록용 출발 열차 — trip의 현재 leg 앵커 기준. 앵커/방향을 모르거나 stamp가 없으면 null. */
export async function loadAnchorDepartures(
  kv: KVNamespace,
  trip: Trip,
  now: number,
): Promise<AnchorDeparturesView | null> {
  const anchor = resolveListAnchor(trip, now);
  if (!anchor) return null;
  let stamp: Awaited<ReturnType<typeof readSelfPollPosition>>;
  try {
    stamp = await readSelfPollPosition(kv, anchor.line as LineNumber);
  } catch {
    return null;
  }
  if (!stamp) return { station: anchor.station, line: anchor.line, departed: [] };
  const { positions, stationLogs } = stamp;
  const departed = departedFromStation(stationLogs, anchor.station, anchor.isUp, now).map(
    ({ trainCode, departedAt }) => ({
      trainCode,
      departedAt,
      currentStation:
        positions.find((p) => p.trainCode === trainCode && p.isUp === anchor.isUp)?.stationName ?? null,
    }),
  );
  return { station: anchor.station, line: anchor.line, departed };
}
