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

const mockDismiss = jest.fn();
const mockEndTrip = jest.fn();

function renderAlarm(type: AlarmEvent['type'], stationName: string) {
  const event: AlarmEvent = { phaseId: 'early', type, stationName };
  return render(
    <AlarmOverlay event={event} onDismiss={mockDismiss} onEndTrip={mockEndTrip} />,
  );
}

async function triggerModalClose(rendered: ReturnType<typeof renderAlarm>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Modal } = require('react-native');
  await rendered.UNSAFE_getByType(Modal).props.onRequestClose();
}

describe('AlarmOverlay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('하차 알림을 표시한다', () => {
    const { getByText } = renderAlarm('destination', '강남');
    expect(getByText('하차 알림')).toBeTruthy();
    expect(getByText('강남에서\n내리세요')).toBeTruthy();
  });

  it('환승 알림을 표시한다', () => {
    const { getByText } = renderAlarm('transfer', '시청');
    expect(getByText('환승 알림')).toBeTruthy();
    expect(getByText('시청에서\n환승하세요')).toBeTruthy();
  });

  it('#633 환승 알람 dismiss → trip 유지. clearAlarmNotification만 호출, onEndTrip X', async () => {
    const { getByTestId } = renderAlarm('transfer', '시청');
    fireEvent.press(getByTestId('alarm-dismiss-button'));
    await waitFor(() => {
      expect(mockClearAlarmNotification).toHaveBeenCalled();
      expect(mockKillAllAlarms).not.toHaveBeenCalled();
      expect(mockEndTrip).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('#633 도착 알람 dismiss → trip 종료. killAllAlarms + onEndTrip 호출', async () => {
    const { getByTestId } = renderAlarm('destination', '강남');
    fireEvent.press(getByTestId('alarm-dismiss-button'));
    await waitFor(() => {
      expect(mockKillAllAlarms).toHaveBeenCalled();
      expect(mockEndTrip).toHaveBeenCalled();
      expect(mockClearAlarmNotification).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('#741 환승 알람의 메인 버튼은 "알람 끄기" 텍스트', () => {
    expect(renderAlarm('transfer', '시청').getByText('알람 끄기')).toBeTruthy();
  });

  it('#741 도착 알람의 메인 버튼도 "알람 끄기" 텍스트 — 라벨 통일', () => {
    expect(renderAlarm('destination', '강남').getByText('알람 끄기')).toBeTruthy();
  });

  describe('#741 보조 버튼 제거 — 단일 액션 UX', () => {
    it('도착 알람에서 보조 버튼이 노출되지 않는다 (회귀 가드)', () => {
      expect(renderAlarm('destination', '강남').queryByTestId('alarm-keep-trip-button')).toBeNull();
    });

    it('환승 알람에서도 보조 버튼이 노출되지 않는다', () => {
      expect(renderAlarm('transfer', '시청').queryByTestId('alarm-keep-trip-button')).toBeNull();
    });

    it('도착 알람 onRequestClose(Android 백 버튼/스와이프)도 trip 종료 동작 — handleDismiss로 통일', async () => {
      const rendered = renderAlarm('destination', '강남');
      await triggerModalClose(rendered);
      await waitFor(() => {
        expect(mockKillAllAlarms).toHaveBeenCalled();
        expect(mockEndTrip).toHaveBeenCalled();
        expect(mockClearAlarmNotification).not.toHaveBeenCalled();
        expect(mockDismiss).toHaveBeenCalled();
      });
    });

    it('환승 알람 onRequestClose는 기존 동작(clearAlarmNotification, trip 유지)', async () => {
      const rendered = renderAlarm('transfer', '시청');
      await triggerModalClose(rendered);
      await waitFor(() => {
        expect(mockClearAlarmNotification).toHaveBeenCalled();
        expect(mockKillAllAlarms).not.toHaveBeenCalled();
        expect(mockEndTrip).not.toHaveBeenCalled();
        expect(mockDismiss).toHaveBeenCalled();
      });
    });
  });
});
