import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  deriveSafetyNetWaypoints,
  registerSafetyNetAlarms,
  rescheduleSafetyNetAlarm,
} from '../safetyNetScheduler';
import { findRoute } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

// #3177 PR-4 — 안전망 waypoint/이벤트가 실제 하차 승강장 id를 싣는다.
jest.mock('expo-notifications');
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
const mockBuildAlarmContent = jest.fn((event: { phaseId: string; stationName: string }) => ({
  title: `T:${event.phaseId}`,
  body: `B:${event.stationName}`,
}));
jest.mock('../stationNotification', () => ({
  buildAlarmContent: (event: { phaseId: string; stationName: string }) => mockBuildAlarmContent(event),
}));
const mockLogScheduledAlarm = jest.fn();
jest.mock('../alarmLog', () => ({
  logScheduledAlarm: (...args: unknown[]) => mockLogScheduledAlarm(...args),
}));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;

const START_TIME = new Date('2026-07-31T09:00:00Z').getTime();
const SADANG = canonicalStationName('사당', '4');
const SINDANG = canonicalStationName('신당', '6');

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
});

describe('safety net — stationId (#3177 PR-4)', () => {
  it('deriveSafetyNetWaypoints: 강남(2) -> 사당(4) waypoint.stationId = 2-026', () => {
    const route = findRoute('2-022', '4-025')!;
    const waypoints = deriveSafetyNetWaypoints(route, SADANG);
    expect(waypoints).toHaveLength(1);
    expect(waypoints[0].stationId).toBe('2-026');
  });

  it('deriveSafetyNetWaypoints: 9-030 -> 6-026 마지막 waypoint = 2-006', () => {
    const route = findRoute('9-030', '6-026')!;
    const waypoints = deriveSafetyNetWaypoints(route, SINDANG);
    expect(waypoints[waypoints.length - 1].stationId).toBe('2-006');
  });

  it('registerSafetyNetAlarms: buildAlarmContent가 받은 이벤트에 stationId', async () => {
    const route = findRoute('2-022', '4-025')!;
    const result = await registerSafetyNetAlarms({
      tripToken: 'T',
      route,
      destinationName: SADANG,
      startTime: START_TIME,
      now: START_TIME,
      outageConfirmed: true,
    });
    expect(result.scheduled).toBe(1);
    expect(mockBuildAlarmContent).toHaveBeenCalledTimes(1);
    expect(mockBuildAlarmContent.mock.calls[0][0]).toMatchObject({ stationName: SADANG, stationId: '2-026' });
    expect(mockLogScheduledAlarm.mock.calls[0][0]).toMatchObject({ stationId: '2-026' });
  });

  it('rescheduleSafetyNetAlarm: 재예약 이벤트에도 stationId', async () => {
    const route = findRoute('2-022', '4-025')!;
    const result = await rescheduleSafetyNetAlarm({
      tripToken: 'T',
      route,
      destinationName: SADANG,
      stationName: SADANG,
      newArrivalMs: START_TIME + 600_000,
      now: START_TIME,
    });
    expect(result.scheduled).toBe(1);
    expect(mockBuildAlarmContent.mock.calls[0][0]).toMatchObject({ stationName: SADANG, stationId: '2-026' });
  });
});
