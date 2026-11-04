/**
 * #3319 PR-d — BG 미러 채택 시 탑승 anchor보다 앞선(이미 지난) 역 미러 거부.
 *
 * 실측(2026-11-04 17:30~17:32, 덤프 la-write-D2 src=backend-ssot;st=성수): 7호선 구간인데 LA가
 * 2호선 성수를 표시. 기존 isBackendSsotRouteRegression은 BG에서 GPS 60s+ stale이면
 * gpsQualityDegraded=true + deviceEstimateArcIndex 없음이라 22분 묵은 미러를 거부하지 못했다.
 * 실제 stations.json을 쓴다(mock 아님) — 경로 순서는 실데이터 기준.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockUpdateFromMirror = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../liveActivityMirrorSync', () => ({
  updateLiveActivityFromMirrorStation: (...args: unknown[]) => mockUpdateFromMirror(...args),
}));

const mockReadBackendSsotMirror = jest.fn(async () => null as unknown);
jest.mock('../backendSsotMirror', () => ({
  ...jest.requireActual('../backendSsotMirror'),
  readBackendSsotMirror: () => mockReadBackendSsotMirror(),
}));

jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => true,
  updateLiveActivity: jest.fn().mockResolvedValue(undefined),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  hasActiveLiveActivity: () => true,
}));
jest.mock('../boardingActivityChannel', () => ({ endBoardingActivity: jest.fn() }));
jest.mock('../stationNotification', () => ({ buildLiveActivityData: jest.fn(() => ({})) }));
jest.mock('../laDismissSentinel', () => ({ isLaDismissed: jest.fn(async () => false) }));
jest.mock('../liveActivityPushChannel', () => ({
  shouldSkipDeviceLiveActivityWrite: jest.fn(async () => false),
  resolveDeviceFallbackSource: jest.fn(async () => undefined),
  reconcileLiveActivityToken: jest.fn(() => Promise.resolve()),
}));
jest.mock('../alarmLog', () => ({
  ...jest.requireActual('../alarmLog'),
  logLaRefreshDecision: jest.fn(),
  logLaWrite: jest.fn(),
}));

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { refreshLiveActivityFromBackgroundContext } from '../refreshLiveActivityFromBackgroundContext';
import {
  BG_LAST_STATION_KEY,
  BOARDING_LOCK_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
  TRIP_ORIGIN_KEY,
} from '../../../../shared/constants/storageKeys';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

// 11/04 trip: 성수(2) 출발 → 건대입구 환승(2→7) → 7호선 용마산 도착.
const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
const konkuk7 = findStationByNameAndLine(canonicalStationName('건대입구', '7'), '7')!;
const junggok = findStationByNameAndLine(canonicalStationName('중곡', '7'), '7')!;
const yongmasan = findStationByNameAndLine(canonicalStationName('용마산', '7'), '7')!;
const transferRoute = {
  type: 'transfer',
  fromLine: '2',
  toLine: '7',
  transferName: canonicalStationName('건대입구', '2'),
};

function boardingLock(boardingStationId: string, destinationId = yongmasan.id) {
  return {
    destinationId,
    trainCode: '7123',
    boardingStationId,
    boardingLine: '7',
    boardedAt: Date.now() - 30 * 60_000,
    expectedDurationMs: 600_000,
  };
}

function setup(lock: object | null): void {
  const values: Record<string, string | null> = {
    [DESTINATION_KEY]: JSON.stringify(yongmasan),
    [TRIP_ORIGIN_KEY]: JSON.stringify(seongsu),
    [ROUTE_KEY]: JSON.stringify(transferRoute),
    [BOARDING_LOCK_KEY]: lock ? JSON.stringify(lock) : null,
    [BG_LAST_STATION_KEY]: null,
  };
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => values[key] ?? null);
}

function mirrorAt(station: { name: string; line: string }, lastAdvanceAgoMs: number) {
  return {
    currentStationId: station.name,
    currentStationLine: station.line,
    motionState: 'moving' as const,
    lastAdvanceEvidence: 'seed',
    lastAdvanceAt: Date.now() - lastAdvanceAgoMs,
    passedStations: [],
    receivedAt: Date.now(),
  };
}

describe('#3319 PR-d — BG 미러 anchor-behind 거부', () => {
  const originalOs = Platform.OS;
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('11/04 덤프: 성수(2) 미러 + lastAdvanceAt 22분 전 + anchor 건대입구(7) lock + GPS 없음 → 미러 거부', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(seongsu, 22 * 60_000));
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).not.toHaveBeenCalled();
  });

  it('(b) 미러가 신선(<180s)해도 탑승 anchor(건대입구/7)보다 route 순서상 앞이면(성수) 거부', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(seongsu, 10_000));
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).not.toHaveBeenCalled();
  });

  it('[채택 유지] anchor 이후 역(중곡) + lastAdvanceAt 22분 전(긴 구간·정차) → 채택 (lastAdvanceAt은 신선도가 아니다, #2261 deadlock 방지)', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(junggok, 22 * 60_000));
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
    expect(mockUpdateFromMirror.mock.calls[0][0]).toMatchObject({ id: junggok.id });
  });

  it('[채택 유지] 신선한 미러(<180s) + anchor 이후 역(중곡) → 채택', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(junggok, 20_000));
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
    expect(mockUpdateFromMirror.mock.calls[0][0]).toMatchObject({ id: junggok.id });
  });

  it('[채택 유지] 미러가 anchor 역 자체(건대입구/7)여도 채택(동일 idx는 behind 아님)', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(konkuk7, 20_000));
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
  });

  it('[채택 유지] lock 없음(anchor 없음) + 신선한 미러 → 채택 (lock-less는 anchor 판정 근거 없음)', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(seongsu, 10_000));
    setup(null);
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
  });

  it('[채택 유지] 다른 목적지의 stale lock은 anchor로 쓰지 않는다', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(seongsu, 10_000));
    setup(boardingLock(konkuk7.id, 'other-destination'));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
  });

  it('[채택 유지] lock anchor가 route arc 밖이면 판정하지 않는다', async () => {
    mockReadBackendSsotMirror.mockResolvedValue(mirrorAt(seongsu, 10_000));
    setup(boardingLock('not-in-arc'));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
  });

  it('[채택 유지] lastAdvanceAt=0(lazy-seed)은 묵음 판정 대상이 아니다', async () => {
    mockReadBackendSsotMirror.mockResolvedValue({ ...mirrorAt(junggok, 0), lastAdvanceAt: 0 });
    setup(boardingLock(konkuk7.id));
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateFromMirror).toHaveBeenCalledTimes(1);
  });
});
