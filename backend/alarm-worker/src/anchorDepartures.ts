/**
 * #3155 — 앵커역 출발 열차 기록/조회 (red 단계 스텁 — 구현은 다음 커밋).
 */
import type { PositionEntry } from './seoul';

/** 출발 열차를 목록/corroboration 근거로 유지하는 창(ms). */
export const ANCHOR_DEPARTURE_WINDOW_MS = 10 * 60_000;

export interface StationPresence {
  trainCode: string;
  isUp: boolean;
  seenAt: number;
}

export interface StationDeparture {
  trainCode: string;
  isUp: boolean;
  departedAt: number;
}

export interface StationTrainLog {
  present: StationPresence[];
  departed: StationDeparture[];
}

export type StationTrainLogs = Record<string, StationTrainLog>;

export type AnchorSighting = 'at-anchor' | 'departed' | 'approaching' | null;

export interface AnchorForSighting {
  station: string;
  isUp: boolean;
  segmentStations: readonly string[];
}

export function updateStationTrainLogs(
  _prev: StationTrainLogs | undefined,
  _positions: readonly PositionEntry[],
  _tracked: ReadonlySet<string>,
  _now: number,
): StationTrainLogs | undefined {
  return undefined;
}

export function departedFromStation(
  _logs: StationTrainLogs | undefined,
  _station: string,
  _isUp: boolean,
  _now: number,
): StationDeparture[] {
  return [];
}

export function classifyAnchorSighting(
  _trainCode: string,
  _anchor: AnchorForSighting,
  _positions: readonly PositionEntry[],
  _logs: StationTrainLogs | undefined,
  _now: number,
): AnchorSighting {
  return null;
}

export function anchorFromSegment(
  _line: string,
  _segmentStations: readonly string[],
): AnchorForSighting | null {
  return null;
}
