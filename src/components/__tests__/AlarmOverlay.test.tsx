import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { AlarmOverlay } from '../AlarmOverlay';
import type { AlarmEvent } from '../../store/useAppStore';

const mockKillAllAlarms = jest.fn().mockResolvedValue(undefined);
const mockClearAlarmNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/alarmKill', () => ({
  killAllAlarms: () => mockKillAllAlarms(),
}));
jest.mock('../../utils/stationNotification', () => ({
  clearAlarmNotification: () => mockClearAlarmNotification(),
}));

describe('AlarmOverlay', () => {
  const mockDismiss = jest.fn();
  const mockEndTrip = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('하차 알림을 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByText } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );
    expect(getByText('하차 알림')).toBeTruthy();
    expect(getByText('강남에서\n내리세요')).toBeTruthy();
  });

  it('환승 알림을 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
    const { getByText } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );
    expect(getByText('환승 알림')).toBeTruthy();
    expect(getByText('시청에서\n환승하세요')).toBeTruthy();
  });

  it('#633 환승 알람 dismiss → trip 유지. clearAlarmNotification만 호출, onEndTrip X', async () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
    const { getByTestId } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );

    fireEvent.press(getByTestId('alarm-dismiss-button'));

    await waitFor(() => {
      expect(mockClearAlarmNotification).toHaveBeenCalled();
      expect(mockKillAllAlarms).not.toHaveBeenCalled();
      expect(mockEndTrip).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('#633 도착 알람 dismiss → trip 종료. killAllAlarms + onEndTrip 호출', async () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByTestId } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );

    fireEvent.press(getByTestId('alarm-dismiss-button'));

    await waitFor(() => {
      expect(mockKillAllAlarms).toHaveBeenCalled();
      expect(mockEndTrip).toHaveBeenCalled();
      expect(mockClearAlarmNotification).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('알람 끄기 버튼 텍스트를 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByText } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );
    expect(getByText('알람 끄기')).toBeTruthy();
  });
});
