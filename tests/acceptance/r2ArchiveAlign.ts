/**
 * R2 ndjson archive ↔ ground truth fixture align utility (P0-4 / #1580).
 *
 * P0-3 (R2 archive)에서 export되는 ndjson 라인을 로드하고,
 * trip 시작/종료 시각으로 잘라낸 뒤 alarm event를 추출하는 helper.
 *
 * P0-3 ndjson 라인 최소 schema (Phase 0 epic 합의):
 *   { "ts": ISOString, "kind": string, ...payload }
 *
 *   - "alarm.fired" — { kind: "alarm.fired", ts, alarmType, stationId? }
 *   - "trip.started" / "trip.ended"
 *   - "station.advance" 등 기타 event
 *
 * 본 모듈은 schema에 강하게 결합하지 않고, "ts + kind 필드를 가진 record"만 가정한다.
 * P0-3 PR 머지 후 실제 ndjson을 받으면 필요한 helper만 추가한다.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface ArchiveEvent {
  ts: string;
  kind: string;
  [key: string]: unknown;
}

export interface AlarmEvent extends ArchiveEvent {
  alarmType: string;
}

/**
 * P0-3에서 알람 발사가 archive에 남길 때 사용하는 kind.
 * 실제 producer가 정해지면 본 상수 그대로 매칭된다.
 */
export const ALARM_FIRED_KIND = 'alarm.fired';

/**
 * R2 ndjson 파일을 읽어 ArchiveEvent[]로 파싱한다.
 * 빈 줄/주석(`#`)은 무시. JSON parse 실패 라인은 throw.
 */
export async function loadR2Trip(ndjsonPath: string): Promise<ArchiveEvent[]> {
  const raw = await fs.readFile(ndjsonPath, 'utf-8');
  const lines = raw.split('\n');
  const events: ArchiveEvent[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`ndjson line ${idx + 1} parse 실패: ${(err as Error).message}`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as ArchiveEvent).ts !== 'string' ||
      typeof (parsed as ArchiveEvent).kind !== 'string'
    ) {
      throw new Error(`ndjson line ${idx + 1}: ts(string) + kind(string) 필드 필수`);
    }
    events.push(parsed as ArchiveEvent);
  });
  return events;
}

/**
 * trip 시작 ~ 종료 시각 범위 안의 event만 필터한다.
 * 경계는 inclusive.
 */
export function sliceTripWindow(
  events: ArchiveEvent[],
  tripStartedAt: string,
  tripEndedAt: string,
): ArchiveEvent[] {
  const start = Date.parse(tripStartedAt);
  const end = Date.parse(tripEndedAt);
  return events.filter((e) => {
    const ts = Date.parse(e.ts);
    return ts >= start && ts <= end;
  });
}

/**
 * 특정 alarmType의 fired event만 추출.
 * alarmType이 undefined면 모든 알람 발사 event 반환.
 */
export function extractAlarmEvents(events: ArchiveEvent[], alarmType?: string): AlarmEvent[] {
  return events.filter((e): e is AlarmEvent => {
    if (e.kind !== ALARM_FIRED_KIND) return false;
    if (typeof (e as AlarmEvent).alarmType !== 'string') return false;
    if (alarmType === undefined) return true;
    return (e as AlarmEvent).alarmType === alarmType;
  });
}

/**
 * 도착 시각 기준 "한 정거장 전" 발사 기대 시각.
 * P0-3 ndjson에 hop duration이 없을 수 있어 fallback 30s를 쓴다.
 * runner는 fixture의 인접 actualStation 간격을 직접 계산해 더 정확한 값을 쓸 수 있다.
 */
export function oneStopBefore(arrivedAt: string, hopMillis = 30_000): number {
  return Date.parse(arrivedAt) - hopMillis;
}

/**
 * fixture 디렉토리에서 `trip-ground-truth-*.json` 파일 경로를 수집.
 * template은 의도적으로 제외 (사용자 입력 X).
 */
export async function listFixtureFiles(fixturesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(fixturesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries
    .filter((f) => f.startsWith('trip-ground-truth-') && f.endsWith('.json'))
    .filter((f) => !f.includes('.template.'))
    .map((f) => path.join(fixturesDir, f))
    .sort();
}
