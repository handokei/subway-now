import { passesLockedStationGate } from '../lockedStationGate';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const S0 = { id: 'S0', name: 'A', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S1 = { id: 'S1', name: 'B', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S2 = { id: 'S2', name: 'C', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S3 = { id: 'S3', name: 'D', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S4 = { id: 'S4', name: 'E', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S5 = { id: 'S5', name: 'F', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const OTHER_LINE_STATION = { id: 'X1', name: 'X', line: '3' as const, lat: 0, lng: 0, lineColor: '#000000' };
const ARC = [S0, S1, S2, S3, S4, S5];

const LOCK: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T1',
  boardingStationId: 'S0',
  boardingLine: '2',
  boardedAt: 0,
  expectedDurationMs: 100_000,
};

describe('passesLockedStationGate', () => {
  it('노선이 lock.boardingLine과 다르면 false', () => {
    expect(passesLockedStationGate(OTHER_LINE_STATION, LOCK, ARC)).toBe(false);
  });

  it('탑승역 이후 arc window(±3 hop) 이내 station은 true', () => {
    expect(passesLockedStationGate(S1, LOCK, ARC)).toBe(true);
    expect(passesLockedStationGate(S3, LOCK, ARC)).toBe(true);
  });

  it('arc window(boardingIdx + 3)를 초과하면 false', () => {
    expect(passesLockedStationGate(S4, LOCK, ARC)).toBe(false);
  });

  it('탑승역보다 이전(backward) station이면 false', () => {
    const lockAtS3: BoardingLock = { ...LOCK, boardingStationId: 'S3' };
    expect(passesLockedStationGate(S1, lockAtS3, ARC)).toBe(false);
  });

  it('탑승역 자체는 true(forward-only 경계값)', () => {
    expect(passesLockedStationGate(S0, LOCK, ARC)).toBe(true);
  });

  it('arcStations가 비어있으면 true(가드 미적용, graceful)', () => {
    expect(passesLockedStationGate(S1, LOCK, [])).toBe(true);
  });

  it('boardingStationId가 arcStations에 없으면 arc-window는 통과(graceful) — forward-only도 면제', () => {
    const lockUnknownBoarding: BoardingLock = { ...LOCK, boardingStationId: 'UNKNOWN' };
    expect(passesLockedStationGate(S5, lockUnknownBoarding, ARC)).toBe(true);
  });

  it('candidate station이 arcStations에 없으면 arc-window 실패로 false', () => {
    const offArcStation = { id: 'OFF', name: 'Off', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
    expect(passesLockedStationGate(offArcStation, LOCK, ARC)).toBe(false);
  });
});
