import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { AlarmOverlay } from '../AlarmOverlay';
import type { AlarmEvent } from '../../store/useAppStore';

const mockClearAlarmNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/stationNotification', () => ({
  clearAlarmNotification: () => mockClearAlarmNotification(),
}));

describe('AlarmOverlay', () => {
  const mockDismiss = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('하차 알림을 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByText } = render(<AlarmOverlay event={event} onDismiss={mockDismiss} />);
    expect(getByText('하차 알림')).toBeTruthy();
    expect(getByText('강남에서\n내리세요')).toBeTruthy();
  });

  it('환승 알림을 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
    const { getByText } = render(<AlarmOverlay event={event} onDismiss={mockDismiss} />);
    expect(getByText('환승 알림')).toBeTruthy();
    expect(getByText('시청에서\n환승하세요')).toBeTruthy();
  });

  it('알람 끄기 버튼을 누르면 사운드를 정지하고 dismiss한다', async () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByTestId } = render(<AlarmOverlay event={event} onDismiss={mockDismiss} />);

    fireEvent.press(getByTestId('alarm-dismiss-button'));

    await waitFor(() => {
      expect(mockClearAlarmNotification).toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('알람 끄기 버튼 텍스트를 표시한다', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByText } = render(<AlarmOverlay event={event} onDismiss={mockDismiss} />);
    expect(getByText('알람 끄기')).toBeTruthy();
  });
});
