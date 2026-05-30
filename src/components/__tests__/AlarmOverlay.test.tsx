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

  it('환승 알람의 메인 버튼은 "알람 끄기" 텍스트', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
    const { getByText } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );
    expect(getByText('알람 끄기')).toBeTruthy();
  });

  it('도착 알람의 메인 버튼은 "내림 (트립 종료)" 텍스트 — UX 의도 명확화', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    const { getByText } = render(
      <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
    );
    expect(getByText('내림 (트립 종료)')).toBeTruthy();
  });

  describe('#673 destination 알람 dismiss 분리', () => {
    it('도착 알람에서 보조 액션 "이 알람만 끄기" 버튼이 노출', () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
      const { getByTestId } = render(
        <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
      );
      expect(getByTestId('alarm-keep-trip-button')).toBeTruthy();
    });

    it('환승 알람에서는 보조 액션 미노출', () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
      const { queryByTestId } = render(
        <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
      );
      expect(queryByTestId('alarm-keep-trip-button')).toBeNull();
    });

    it('도착 알람 보조 액션 → clearAlarmNotification만, killAllAlarms·onEndTrip 호출 안 함', async () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
      const { getByTestId } = render(
        <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
      );

      fireEvent.press(getByTestId('alarm-keep-trip-button'));

      await waitFor(() => {
        expect(mockClearAlarmNotification).toHaveBeenCalled();
        expect(mockKillAllAlarms).not.toHaveBeenCalled();
        expect(mockEndTrip).not.toHaveBeenCalled();
        expect(mockDismiss).toHaveBeenCalled();
      });
    });

    it('도착 알람 onRequestClose(Android 백 버튼)는 trip 유지 동작(보조 액션과 동일)', async () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
      const { UNSAFE_getByType } = render(
        <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
      );
      // Modal의 onRequestClose를 직접 호출 — react-native testing-library가 fireEvent로 백 버튼
      // 시뮬레이션 미지원이라 prop 직접 트리거.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Modal } = require('react-native');
      const modal = UNSAFE_getByType(Modal);
      await modal.props.onRequestClose();
      await waitFor(() => {
        expect(mockClearAlarmNotification).toHaveBeenCalled();
        expect(mockKillAllAlarms).not.toHaveBeenCalled();
        expect(mockEndTrip).not.toHaveBeenCalled();
        expect(mockDismiss).toHaveBeenCalled();
      });
    });

    it('환승 알람 onRequestClose는 기존 동작(clearAlarmNotification, trip 유지)', async () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
      const { UNSAFE_getByType } = render(
        <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Modal } = require('react-native');
      const modal = UNSAFE_getByType(Modal);
      await modal.props.onRequestClose();
      await waitFor(() => {
        expect(mockClearAlarmNotification).toHaveBeenCalled();
        expect(mockEndTrip).not.toHaveBeenCalled();
      });
    });
  });
});
