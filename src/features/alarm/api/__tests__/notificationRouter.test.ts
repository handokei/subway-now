import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetRouterSingletonForTest,
  getNotificationRouter,
} from '../notificationRouter';
import { __resetDeliveryLogForTest } from '../../../notice/store/notificationDeliveryLog';
import { BACKEND_SSOT_MIRROR_KEY, ROUTE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id-1'),
}));

const mockSaveStationToWidget = jest.fn();
const mockClearWidgetStation = jest.fn();
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
  clearWidgetStation: () => mockClearWidgetStation(),
}));

const mockSetAlarmEvent = jest.fn();
jest.mock('../../store/useAlarmEventStore', () => ({
  useAlarmEventStore: {
    getState: () => ({ setAlarmEvent: mockSetAlarmEvent }),
  },
}));

// #1929 F-W4: notification widget surface가 useDestinationStore.getState().destination로 tripContext 구성.
const mockDestinationGetState = jest.fn(() => ({ destination: null as { id: string; name: string } | null }));
jest.mock('../../../route/store/useDestinationStore', () => ({
  useDestinationStore: {
    getState: () => mockDestinationGetState(),
  },
}));

const scheduleSpy = Notifications.scheduleNotificationAsync as jest.Mock;

describe('notificationRouter wiring (#1575 T12)', () => {
  beforeEach(async () => {
    __resetRouterSingletonForTest();
    __resetDeliveryLogForTest();
    await AsyncStorage.clear();
    scheduleSpy.mockClear();
    mockSaveStationToWidget.mockClear();
    mockClearWidgetStation.mockClear();
    mockSetAlarmEvent.mockClear();
    mockDestinationGetState.mockReturnValue({ destination: null });
  });

  it('getNotificationRouter returns same singleton on repeat call', () => {
    const r1 = getNotificationRouter();
    const r2 = getNotificationRouter();
    expect(r1).toBe(r2);
  });

  it('banner surface fans out to Notifications.scheduleNotificationAsync', async () => {
    const router = getNotificationRouter();
    const result = await router.deliver({
      alarmId: 'a-1',
      eventKey: 'station-passed:중곡',
      surface: 'banner',
      content: { title: 'T', body: 'B', data: { foo: 'bar' } },
      source: 'bg-silent-push',
    });
    expect(result.delivered).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith({
      content: { title: 'T', body: 'B', data: { foo: 'bar' } },
      trigger: null,
    });
  });

  it('banner surface omits data field when content.data is undefined', async () => {
    const router = getNotificationRouter();
    await router.deliver({
      alarmId: 'a-2',
      eventKey: 'e',
      surface: 'banner',
      content: { title: 'T', body: 'B' },
      source: 'fg',
    });
    expect(scheduleSpy).toHaveBeenCalledWith({
      content: { title: 'T', body: 'B' },
      trigger: null,
    });
  });

  it('widget surface calls saveStationToWidget when station + distanceKm present (destination null → tripContext undefined)', async () => {
    const router = getNotificationRouter();
    const station = { id: '0228', name: '강남', lat: 0, lng: 0 };
    await router.deliver({
      alarmId: 'a-3',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B', data: { station, distanceKm: 0.05 } },
      source: 'fg',
    });
    // #1929 F-W4: destination null → buildWidgetTripContext returns null → undefined forward
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(station, 0.05, undefined, undefined, undefined);
  });

  it('#1929 F-W4 — destination + route(direct) 있으면 tripContext stamp (nextTransferName undefined)', async () => {
    const router = getNotificationRouter();
    const station = { id: '0228', name: '강남', lat: 0, lng: 0 };
    const destination = { id: '0240', name: '잠실', lat: 0, lng: 0 };
    mockDestinationGetState.mockReturnValue({ destination });
    await AsyncStorage.setItem(
      ROUTE_KEY,
      JSON.stringify({ type: 'direct', stops: 5, line: '2', travelSeconds: 600 }),
    );
    await router.deliver({
      alarmId: 'a-3a',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B', data: { station, distanceKm: 0.05 } },
      source: 'fg',
    });
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      station,
      0.05,
      undefined,
      undefined,
      expect.objectContaining({
        tripActive: true,
        currentStationName: '강남',
        destinationName: '잠실',
        nextTransferName: undefined,
      }),
    );
  });

  it('#1929 F-W4 — destination + route(transfer) 있으면 tripContext에 nextTransferName stamp', async () => {
    const router = getNotificationRouter();
    const station = { id: '0228', name: '강남', lat: 0, lng: 0 };
    const destination = { id: '0240', name: '잠실', lat: 0, lng: 0 };
    mockDestinationGetState.mockReturnValue({ destination });
    await AsyncStorage.setItem(
      ROUTE_KEY,
      JSON.stringify({
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 3,
        stopsFromTransfer: 4,
        secondsToTransfer: 360,
        secondsFromTransfer: 480,
      }),
    );
    await router.deliver({
      alarmId: 'a-3b',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B', data: { station, distanceKm: 0.05 } },
      source: 'fg',
    });
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      station,
      0.05,
      undefined,
      undefined,
      expect.objectContaining({
        tripActive: true,
        nextTransferName: '교대',
      }),
    );
  });

  it('#1929 F-W4 — ROUTE_KEY parse 실패 → route null로 graceful (tripContext에 nextTransferName undefined)', async () => {
    const router = getNotificationRouter();
    const station = { id: '0228', name: '강남', lat: 0, lng: 0 };
    const destination = { id: '0240', name: '잠실', lat: 0, lng: 0 };
    mockDestinationGetState.mockReturnValue({ destination });
    await AsyncStorage.setItem(ROUTE_KEY, 'not-json-{{{{');
    await router.deliver({
      alarmId: 'a-3c',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B', data: { station, distanceKm: 0.05 } },
      source: 'fg',
    });
    // graceful: route null이어도 tripContext는 활성 (destination + currentStation 있음)
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      station,
      0.05,
      undefined,
      undefined,
      expect.objectContaining({
        tripActive: true,
        nextTransferName: undefined,
      }),
    );
  });

  it('widget surface no-ops when station or distanceKm missing', async () => {
    const router = getNotificationRouter();
    await router.deliver({
      alarmId: 'a-4',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B' },
      source: 'fg',
    });
    expect(mockSaveStationToWidget).not.toHaveBeenCalled();
  });

  it('widget surface no-ops when distanceKm not number', async () => {
    const router = getNotificationRouter();
    await router.deliver({
      alarmId: 'a-4b',
      eventKey: 'e',
      surface: 'widget',
      content: { title: 'T', body: 'B', data: { station: { id: '1' } } },
      source: 'fg',
    });
    expect(mockSaveStationToWidget).not.toHaveBeenCalled();
  });

  it('in-app surface calls setAlarmEvent when alarmEvent present', async () => {
    const router = getNotificationRouter();
    const alarmEvent = {
      phaseId: 'early',
      type: 'destination',
      stationName: '강남',
    };
    await router.deliver({
      alarmId: 'a-5',
      eventKey: 'e',
      surface: 'in-app',
      content: { title: 'T', body: 'B', data: { alarmEvent } },
      source: 'fg-phase',
    });
    expect(mockSetAlarmEvent).toHaveBeenCalledWith(alarmEvent);
  });

  it('in-app surface no-ops when alarmEvent missing', async () => {
    const router = getNotificationRouter();
    await router.deliver({
      alarmId: 'a-6',
      eventKey: 'e',
      surface: 'in-app',
      content: { title: 'T', body: 'B' },
      source: 'fg-phase',
    });
    expect(mockSetAlarmEvent).not.toHaveBeenCalled();
  });

  it('live-activity surface is no-op in PR-A (후속 PR에서 wire)', async () => {
    const router = getNotificationRouter();
    const result = await router.deliver({
      alarmId: 'a-7',
      eventKey: 'e',
      surface: 'live-activity',
      content: { title: 'T', body: 'B' },
      source: 'bg-silent-push',
    });
    expect(result.delivered).toBe(true);
  });

  it('readSsotMirror adapter reads backend SSoT mirror from AsyncStorage', async () => {
    const mirror = {
      currentStationId: '0228',
      motionState: 'moving',
      lastAdvanceEvidence: 'gps',
      lastAdvanceAt: 1_000,
      passedStations: ['0228'],
      receivedAt: Date.now(),
    };
    await AsyncStorage.setItem(BACKEND_SSOT_MIRROR_KEY, JSON.stringify(mirror));
    const router = getNotificationRouter();
    const result = await router.deliver({
      alarmId: 'a-8',
      eventKey: 'e',
      surface: 'banner',
      content: { title: 'T', body: 'B', data: { stationId: '0228' } },
      source: 'bg-silent-push',
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('gate-station-already-passed');
  });

  it('readSsotMirror adapter returns null when mirror absent (router gate auto-pass)', async () => {
    const router = getNotificationRouter();
    const result = await router.deliver({
      alarmId: 'a-9',
      eventKey: 'e',
      surface: 'banner',
      content: { title: 'T', body: 'B', data: { stationId: '0228' } },
      source: 'bg-silent-push',
    });
    expect(result.delivered).toBe(true);
  });

  it('clearAllForTrip clears widget station', async () => {
    const router = getNotificationRouter();
    await router.clearAllForTrip();
    expect(mockClearWidgetStation).toHaveBeenCalledTimes(1);
  });
});
