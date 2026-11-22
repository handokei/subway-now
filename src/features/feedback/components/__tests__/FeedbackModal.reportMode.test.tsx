/**
 * #3366 — 실 collector + 실 buildDumpText 통합. 버그 신고 보내기 시
 *  (a) 송신 본문에 좌표·raw token·token 끝 8자가 0건이고,
 *  (b) 부수효과 훅(watch·폴링·센서·네트워크)을 마운트/호출하지 않으며,
 *  (c) tripKey는 hashTripToken(APNS token)이다.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { FeedbackModal } from '../FeedbackModal';
import { submitFeedback } from '../../../../shared/api/feedback';
import { hashTripToken } from '../../../../shared/infra/monitoring/tripTokenHash';
import { ACTIVE_TRIP_KEY, APNS_TOKEN_KEY } from '../../../../shared/constants/storageKeys';
import { pushRawSignal, __resetRawSignalForTests__ } from '../../../observability/utils/rawSignalBuffer';
import { clearBackendCallEntries, pushBackendCallEntry } from '../../../../shared/utils/backendCallBuffer';
import {
  FIXTURE_ACTIVE_TRIP_TOKEN,
  FIXTURE_APNS_TOKEN,
  FIXTURE_BACKEND_CALLS,
  FIXTURE_RAW_SIGNALS,
} from '../../../debug/components/__tests__/fixtures/dumpFixture';

jest.mock('../../../../shared/api/feedback', () => ({ submitFeedback: jest.fn() }));

// expo-task-manager native 체인 차단 + 1회 읽기 대체.
const mockReadSilentPushDiagnostics = jest.fn();
const mockUseSilentPushDiagnostics = jest.fn();
jest.mock('../../../alarm/hooks/useSilentPushDiagnostics', () => ({
  useSilentPushDiagnostics: (...a: unknown[]) => mockUseSilentPushDiagnostics(...a),
  readSilentPushDiagnostics: () => mockReadSilentPushDiagnostics(),
}));
jest.mock('live-activity', () => ({}));

const mockDumpScheduled = jest.fn();
jest.mock('../../../alarm/utils/scheduledNotificationsDump', () => ({
  ...jest.requireActual('../../../alarm/utils/scheduledNotificationsDump'),
  dumpScheduledNotifications: () => mockDumpScheduled(),
}));

// 부수효과 모듈 — 하나라도 호출되면 실패.
const mockWatchPositionAsync = jest.fn();
jest.mock('expo-location', () => ({
  watchPositionAsync: (...a: unknown[]) => mockWatchPositionAsync(...a),
  Accuracy: {},
}));
const mockUseFused = jest.fn();
jest.mock('../../../nearest-station/hooks/useFusedNearestStation', () => ({
  useFusedNearestStation: (...a: unknown[]) => mockUseFused(...a),
}));
const mockUseArrival = jest.fn();
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (...a: unknown[]) => mockUseArrival(...a),
}));
const mockUseBarometer = jest.fn();
jest.mock('../../../../shared/hooks/useBarometer', () => ({
  useBarometer: (...a: unknown[]) => mockUseBarometer(...a),
}));
const mockUseLowPower = jest.fn();
jest.mock('../../../../shared/hooks/useLowPowerMode', () => ({
  useLowPowerMode: (...a: unknown[]) => mockUseLowPower(...a),
}));
const mockUseArchFlag = jest.fn();
jest.mock('../../../../shared/config/useArchFlagRemote', () => ({
  useArchFlagRemote: (...a: unknown[]) => mockUseArchFlag(...a),
}));

const mockedSubmit = submitFeedback as jest.MockedFunction<typeof submitFeedback>;

const DIAG = {
  apnsToken: FIXTURE_APNS_TOKEN,
  activeTripToken: FIXTURE_ACTIVE_TRIP_TOKEN,
  apnsEnv: 'production',
  apnsEnvStamped: 'production',
  permissionStatus: null,
  taskRegistrationState: 'unknown',
  taskRegistrationError: null,
  lastReceivedAt: null,
  lastFiredAt: null,
  lastSkippedAt: null,
  hasRoute: true,
  destinationId: '2-222',
  lastNotifiedStationId: null,
};

describe('FeedbackModal report 모드 통합 (#3366)', () => {
  let fetchSpy: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(APNS_TOKEN_KEY, FIXTURE_APNS_TOKEN);
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, FIXTURE_ACTIVE_TRIP_TOKEN);
    mockReadSilentPushDiagnostics.mockResolvedValue(DIAG);
    mockDumpScheduled.mockResolvedValue([
      {
        identifier: `alarm-${FIXTURE_ACTIVE_TRIP_TOKEN}-station-passed-2-212`,
        fireAtMs: 1,
        title: '다음 역',
        body: '',
      },
    ]);
    mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
    __resetRawSignalForTests__();
    clearBackendCallEntries();
    FIXTURE_RAW_SIGNALS.forEach(pushRawSignal);
    FIXTURE_BACKEND_CALLS.forEach(pushBackendCallEntry);
    fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetRawSignalForTests__();
    clearBackendCallEntries();
  });

  const sendWithChip = async () => {
    const api = renderWithTheme(<FeedbackModal visible onClose={jest.fn()} />);
    await act(async () => {
      fireEvent.press(api.getByTestId('feedback-chip-alarm-missing'));
    });
    await act(async () => {
      fireEvent.press(api.getByTestId('feedback-submit'));
    });
    return api;
  };

  it('송신 diagnostics에 좌표·raw token·token 끝 8자가 없다', async () => {
    await sendWithChip();
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const diagnostics = mockedSubmit.mock.calls[0][1]?.diagnostics as string;
    expect(diagnostics.length).toBeGreaterThan(1000);
    expect(diagnostics).not.toContain('37.54321');
    expect(diagnostics).not.toContain('127.05432');
    expect(diagnostics).not.toContain(FIXTURE_APNS_TOKEN);
    expect(diagnostics).not.toContain(FIXTURE_ACTIVE_TRIP_TOKEN);
    expect(diagnostics).not.toContain(FIXTURE_APNS_TOKEN.slice(-8));
    expect(diagnostics).not.toContain(FIXTURE_ACTIVE_TRIP_TOKEN.slice(-8));
    expect(diagnostics).not.toMatch(/[0-9a-fA-F]{40,}/);
    expect(diagnostics).toContain(`apnsToken=[token:${hashTripToken(FIXTURE_APNS_TOKEN)}]`);
    // 오탐 fixture는 보존.
    expect(diagnostics).toContain('arc=33.53');
    expect(diagnostics).toContain('arc=4636.57');
  });

  it('report.tripKey = hashTripToken(APNS token)', async () => {
    await sendWithChip();
    expect(mockedSubmit.mock.calls[0][1]?.report?.tripKey).toBe(hashTripToken(FIXTURE_APNS_TOKEN));
  });

  it('APNS token이 저장돼 있지 않으면 tripKey를 보내지 않는다', async () => {
    await AsyncStorage.removeItem(APNS_TOKEN_KEY);
    mockReadSilentPushDiagnostics.mockResolvedValue({ ...DIAG, apnsToken: null });
    await sendWithChip();
    const report = mockedSubmit.mock.calls[0][1]?.report;
    expect(report).not.toHaveProperty('tripKey');
  });

  it('watchPositionAsync·도착정보 fetch·부수효과 훅을 호출하지 않는다', async () => {
    await sendWithChip();
    expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockUseFused).not.toHaveBeenCalled();
    expect(mockUseArrival).not.toHaveBeenCalled();
    expect(mockUseBarometer).not.toHaveBeenCalled();
    expect(mockUseLowPower).not.toHaveBeenCalled();
    expect(mockUseArchFlag).not.toHaveBeenCalled();
    expect(mockUseSilentPushDiagnostics).not.toHaveBeenCalled();
  });

  it('마운트만으로도 부수효과 훅·watch를 띄우지 않는다', () => {
    renderWithTheme(<FeedbackModal visible onClose={jest.fn()} />);
    expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    expect(mockUseFused).not.toHaveBeenCalled();
    expect(mockUseArrival).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
