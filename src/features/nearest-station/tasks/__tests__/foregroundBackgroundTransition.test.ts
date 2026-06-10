/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * FG↔BG 전환 시나리오 통합 테스트.
 *
 * 단위 테스트(stationPipeline / backgroundLocationTask / notificationState)는 각자
 * 자기 모듈만 보지만, 큐 #242/#244/#249에서 도입된 정책 — 단일 출처 dedup, 게이트
 * 비대칭(BG timeInterval 30s × MAX_LOCATION_AGE_MS 15s, MAX_ACCURACY_M 200m) — 은
 * 모듈 간 **결합**에서 의미를 가진다. 이 테스트는 다음 모듈들을 실제로 함께
 * 돌려서 그 결합 자체를 회귀 가드한다.
 *
 *   - `notificationState`     (실제)
 *   - `locationGates`         (실제)
 *   - `stationPipeline`       (실제)
 *   - `backgroundLocationTask`(실제 defineTask 콜백)
 *   - `stationAlarm`          (실제 evaluateAlarmPhase / alarmKey)
 *
 * 외부 boundary만 mock:
 *   - AsyncStorage → 인메모리 Map (FG/BG가 같은 저장소 공유)
 *   - findNearestStation / stationRoute / stationNotification → 결정적 fake
 */

// ── AsyncStorage: FG/BG 단일 출처 검증을 위해 인메모리 Map으로 구현 ──
const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  }),
}));

// ── TaskManager: BG task 콜백 캡처 ──
jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__bgTaskCallback = callback;
    (global as any).__bgTaskName = name;
  },
}));

jest.mock('expo-location', () => ({}));

// ── 외부 boundary fake: 결정적 동작 ──
const fakeStation = {
  id: 'station-1',
  name: '강남',
  line: '2' as const,
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};
const fakeNextStation = {
  id: 'station-2',
  name: '역삼',
  line: '2' as const,
  lineColor: '#009246',
  lat: 37.5,
  lng: 127.04,
};
const fakeDestination = {
  id: 'station-9',
  name: '시청',
  line: '1' as const,
  lineColor: '#0052A4',
  lat: 37.565,
  lng: 126.977,
};

const mockFindNearestStation = jest.fn();
jest.mock('../../utils/findNearestStation', () => ({
  findNearestStation: (...args: unknown[]) => mockFindNearestStation(...args),
}));

const mockFindRoute = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: jest.fn(() => 10),
  updateRouteFromPosition: jest.fn(() => null),
  isStationOnRoute: jest.fn(() => true),
  // #750 — stationPipeline의 sleep 게이트가 isSameStationName으로 첫 hop을 매칭.
  // 결정적 fake: strict equality로 충분 (테스트는 동일 한국어 이름 사용).
  isSameStationName: (a: string, b: string) => a === b,
  // direct route 테스트만 사용 — 첫 leg endName은 항상 destinationName.
  getFirstLeg: (_route: unknown, destinationName: string) => ({ line: '2', endName: destinationName }),
}));

const mockSendAlarmNotification = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockSendStationPassedNotification = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockUpdateStationNotification = jest.fn((..._args: unknown[]) => Promise.resolve());
jest.mock('../../../alarm/utils/stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ── 모듈 import (defineTask 실행 시점) ──
import '../../tasks/backgroundLocationTask';
import { processLocationUpdate } from '../../../alarm/utils/stationPipeline';
import { alarmKey } from '../../../alarm/utils/stationAlarm';
import {
  DESTINATION_KEY,
  LAST_NOTIFIED_STATION_KEY,
  FIRED_ALARMS_KEY,
} from '../../../../shared/constants/storageKeys';
import { MAX_LOCATION_AGE_MS, MAX_ACCURACY_M } from '../../../../shared/constants/location';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

// ── 테스트 버퍼 상수: 임계값 안쪽/바깥쪽임을 이름으로 드러낸다 ──
const FRESH_MARGIN_MS = 1_000;
const STALE_MARGIN_MS = 5_000;
const NEAR_STATION_KM = 0.05;
const ACCURATE_MARGIN_M = 50;

type TaskCtx = { data: unknown; error: { message: string } | null };
type TaskCallback = (ctx: TaskCtx) => Promise<void>;
const bgTask = (): TaskCallback => (global as any).__bgTaskCallback as TaskCallback;

interface BgRunOptions {
  ageMs?: number;
  accuracy?: number | null;
}

// firedAlarms 저장 포맷(#462): { destinationId, alarms } — destination scoped.
// 다른 destinationId가 저장돼 있으면 빈 set으로 간주하는 헬퍼 — 실제 production read 동작과 일치.
function readFiredForDestination(destinationId: string): Set<string> {
  const raw = mockStorage.get(FIRED_ALARMS_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.destinationId === destinationId && Array.isArray(parsed.alarms)) {
      return new Set(parsed.alarms);
    }
  } catch {
    // ignore
  }
  return new Set();
}

function writeFiredForDestination(destinationId: string, alarms: Set<string>): void {
  mockStorage.set(FIRED_ALARMS_KEY, JSON.stringify({ destinationId, alarms: [...alarms] }));
}

async function runFgPipelineAt(station: typeof fakeStation) {
  mockFindNearestStation.mockReturnValueOnce({ station, distanceKm: NEAR_STATION_KM });
  const firedAlarms = readFiredForDestination(fakeDestination.id);
  const result = await processLocationUpdate({
    lat: station.lat,
    lng: station.lng,
    destination: fakeDestination,
    firedAlarms,
    sleepMode: false,
    source: 'fg',
  });
  // FG의 useStationAlarm 훅이 알람 발사 후 FIRED_ALARMS_KEY를 갱신하는 동작을 시뮬레이션.
  // 이 round-trip이 BG와의 dedup 단일 출처가 된다.
  if (result.alarmEvent) {
    firedAlarms.add(alarmKey(result.alarmEvent));
    writeFiredForDestination(fakeDestination.id, firedAlarms);
  }
  return result;
}

async function runBgTaskAt(station: typeof fakeStation, opts: BgRunOptions = {}) {
  mockFindNearestStation.mockReturnValueOnce({ station, distanceKm: NEAR_STATION_KM });
  return bgTask()({
    data: {
      locations: [
        {
          coords: {
            latitude: station.lat,
            longitude: station.lng,
            altitude: null,
            accuracy: opts.accuracy ?? null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: Date.now() - (opts.ageMs ?? 0),
        },
      ],
    },
    error: null,
  });
}

interface BgBatchEntry {
  station: typeof fakeStation;
  ageMs?: number;
  accuracy?: number | null;
}

async function runBgTaskBatch(entries: BgBatchEntry[]) {
  // BG는 entries[length-1]만 처리하므로 findNearestStation mock도 한 번만 소비.
  mockFindNearestStation.mockReturnValueOnce({
    station: entries[entries.length - 1].station,
    distanceKm: NEAR_STATION_KM,
  });
  return bgTask()({
    data: {
      locations: entries.map((entry) => ({
        coords: {
          latitude: entry.station.lat,
          longitude: entry.station.lng,
          altitude: null,
          accuracy: entry.accuracy ?? null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now() - (entry.ageMs ?? 0),
      })),
    },
    error: null,
  });
}

beforeEach(() => {
  mockStorage.clear();
  mockFindNearestStation.mockReset();
  mockFindRoute.mockReset();
  // 기본: 'early' phase가 트리거되지 않는 multi-stop direct route — 알림 발사만 검증
  mockFindRoute.mockReturnValue(makeDirectRoute(3, '2'));
  mockSendStationPassedNotification.mockClear();
  mockSendAlarmNotification.mockClear();
  mockUpdateStationNotification.mockClear();
});

describe('FG↔BG 통합: 알림 dedup (notificationState 단일 출처)', () => {
  beforeEach(() => {
    mockStorage.set(DESTINATION_KEY, JSON.stringify(fakeDestination));
  });

  it('FG에서 알림 발사 후 BG가 같은 역 받으면 중복 발사하지 않는다', async () => {
    await runFgPipelineAt(fakeStation);
    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBe(fakeStation.id);

    await runBgTaskAt(fakeStation);

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
  });

  it('BG에서 알림 발사 후 FG가 같은 역 받으면 중복 발사하지 않는다', async () => {
    await runBgTaskAt(fakeStation);
    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBe(fakeStation.id);

    await runFgPipelineAt(fakeStation);

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
  });

  it('FG 알림 후 다른 역으로 진입하면 FG/BG 어디서 받든 새 알림이 발사된다', async () => {
    await runFgPipelineAt(fakeStation);
    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);

    await runBgTaskAt(fakeNextStation);

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(2);
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBe(fakeNextStation.id);
  });

  it('AsyncStorage가 비어 있는 cold start(swipe-kill 직후)에는 BG 첫 콜백이 알림을 발사한다', async () => {
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBeUndefined();

    await runBgTaskAt(fakeStation);

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBe(fakeStation.id);
  });
});

describe('FG↔BG 통합: 알람 dedup (FIRED_ALARMS_KEY 단일 출처)', () => {
  beforeEach(() => {
    mockStorage.set(DESTINATION_KEY, JSON.stringify(fakeDestination));
    // 'early' phase 트리거: 도착역까지 1 정거장 (APPROACH_STOPS=1)
    mockFindRoute.mockReturnValue(makeDirectRoute(1, '2'));
  });

  it('FG에서 알람 발사 후 BG가 같은 phase 조건을 받으면 evaluateAlarmPhase가 dedup한다', async () => {
    await runFgPipelineAt(fakeStation);
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
    expect(mockStorage.get(FIRED_ALARMS_KEY)).toBeDefined();

    await runBgTaskAt(fakeStation);

    // BG가 FIRED_ALARMS_KEY를 읽어 firedAlarms Set으로 만들고,
    // evaluateAlarmPhase가 동일 키를 보고 null 반환 → sendAlarmNotification 무호출.
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('BG에서 알람 발사 후 FG가 같은 phase 조건을 받으면 dedup된다', async () => {
    await runBgTaskAt(fakeStation);
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
    const firedJson = mockStorage.get(FIRED_ALARMS_KEY);
    expect(firedJson).toBeDefined();

    await runFgPipelineAt(fakeStation);

    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });
});

describe('FG↔BG 통합: 게이트 비대칭 (BG timeInterval 30s × age 15s, accuracy 200m)', () => {
  beforeEach(() => {
    mockStorage.set(DESTINATION_KEY, JSON.stringify(fakeDestination));
  });

  it('age < MAX_LOCATION_AGE_MS인 신선한 좌표는 BG 게이트를 통과해 알림으로 이어진다', async () => {
    await runBgTaskAt(fakeStation, { ageMs: MAX_LOCATION_AGE_MS - FRESH_MARGIN_MS });

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
  });

  it('age > MAX_LOCATION_AGE_MS인 stale 좌표(BG timeInterval 30s로 인한 캐시 fix)는 게이트가 drop한다', async () => {
    await runBgTaskAt(fakeStation, { ageMs: MAX_LOCATION_AGE_MS + STALE_MARGIN_MS });

    expect(mockFindNearestStation).not.toHaveBeenCalled();
    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBeUndefined();
  });

  it('accuracy <= MAX_ACCURACY_M인 좌표는 BG 게이트를 통과한다', async () => {
    await runBgTaskAt(fakeStation, { accuracy: MAX_ACCURACY_M - ACCURATE_MARGIN_M });

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
  });

  it('accuracy > MAX_ACCURACY_M인 저정확도 좌표는 BG 게이트가 drop한다', async () => {
    await runBgTaskAt(fakeStation, { accuracy: MAX_ACCURACY_M + ACCURATE_MARGIN_M });

    expect(mockFindNearestStation).not.toHaveBeenCalled();
    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBeUndefined();
  });

  // iOS deferred 배치에 stale + fresh 좌표가 섞여 들어올 때, BG task는 locations[length-1]만
  // 처리한다. 마지막 좌표가 fresh면 통과해 알림, stale이면 drop — 이 계약을 회귀 가드한다.
  it('multi-location 배치의 마지막 좌표가 fresh면 통과해 알림으로 이어진다', async () => {
    await runBgTaskBatch([
      { station: fakeStation, ageMs: MAX_LOCATION_AGE_MS + STALE_MARGIN_MS },
      { station: fakeStation, ageMs: MAX_LOCATION_AGE_MS - FRESH_MARGIN_MS },
    ]);

    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
  });

  it('multi-location 배치의 마지막 좌표가 stale이면 drop된다 (앞쪽 fresh 무시)', async () => {
    await runBgTaskBatch([
      { station: fakeStation, ageMs: MAX_LOCATION_AGE_MS - FRESH_MARGIN_MS },
      { station: fakeStation, ageMs: MAX_LOCATION_AGE_MS + STALE_MARGIN_MS },
    ]);

    expect(mockFindNearestStation).not.toHaveBeenCalled();
    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
  });
});

// notificationState는 in-process 캐시 없이 매번 AsyncStorage를 읽으므로,
// "BG 알림 발사 → 프로세스 종료(swipe-kill) → 재진입한 FG가 같은 역 받음"은
// AsyncStorage 영속성만으로 dedup이 보장된다. 이 describe는 그 계약을 명시 회귀 가드한다.
// (모듈 in-memory state로 dedup이 새어 들어가면 이 테스트가 깨진다.)
describe('FG↔BG 통합: swipe-kill 후 재진입 (AsyncStorage 영속성)', () => {
  beforeEach(() => {
    mockStorage.set(DESTINATION_KEY, JSON.stringify(fakeDestination));
  });

  it('BG가 lastNotifiedStationId 기록 후 모듈 상태가 전부 리셋돼도 FG 재진입 시 중복 알림 없음', async () => {
    await runBgTaskAt(fakeStation);
    expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    const persistedId = mockStorage.get(LAST_NOTIFIED_STATION_KEY);
    expect(persistedId).toBe(fakeStation.id);

    // swipe-kill 시뮬레이션: AsyncStorage는 보존, send mock 만 리셋해 "재진입 후 새 send" 검증.
    mockSendStationPassedNotification.mockClear();
    expect(mockStorage.get(LAST_NOTIFIED_STATION_KEY)).toBe(persistedId);

    await runFgPipelineAt(fakeStation);

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
  });

  it('BG 알람 발사 후 swipe-kill을 거쳐 FG 재진입해도 firedAlarms는 영속 dedup된다', async () => {
    mockFindRoute.mockReturnValue(makeDirectRoute(1, '2'));
    await runBgTaskAt(fakeStation);
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
    const firedJson = mockStorage.get(FIRED_ALARMS_KEY);
    expect(firedJson).toBeDefined();

    mockSendAlarmNotification.mockClear();
    expect(mockStorage.get(FIRED_ALARMS_KEY)).toBe(firedJson);

    await runFgPipelineAt(fakeStation);

    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });
});
