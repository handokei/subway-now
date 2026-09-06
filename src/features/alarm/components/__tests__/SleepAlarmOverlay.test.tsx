import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { SleepAlarmOverlay } from '../SleepAlarmOverlay';
import type { AlarmEvent } from '../../../../shared/types/alarm';
import type { LineNumber } from '../../../../shared/types/station';
import type { ExitInfoProvider } from '../../../exit-info/providers/types';
import type { ExitInfo } from '../../../../shared/types/exitInfo';

const mockKillAllAlarms = jest.fn().mockResolvedValue(undefined);
const mockClearAlarmNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/alarmKill', () => ({
  killAllAlarms: () => mockKillAllAlarms(),
}));
jest.mock('../../utils/stationNotification', () => ({
  clearAlarmNotification: () => mockClearAlarmNotification(),
}));

// #2520 — dismiss가 BoardingLock(trip)을 절대 건드리지 않는다는 회귀 가드(#673/#806/#741/#746).
// SleepAlarmOverlay는 이 모듈을 import조차 하지 않지만, 만약 향후 리팩터로 의존이 생기더라도
// getBoardingLock/setBoardingLock/clearBoardingLock 중 아무것도 호출되지 않아야 함을 직접 assert한다.
const mockGetBoardingLock = jest.fn();
const mockSetBoardingLock = jest.fn();
const mockClearBoardingLock = jest.fn();
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
  setBoardingLock: () => mockSetBoardingLock(),
  clearBoardingLock: () => mockClearBoardingLock(),
}));

const mockDismiss = jest.fn();

function makeExitProvider(exits: ExitInfo[]): ExitInfoProvider {
  return { getExits: jest.fn(async () => exits) };
}

function renderAlarm(
  type: AlarmEvent['type'],
  stationName: string,
  phaseId: AlarmEvent['phaseId'] = 'early',
  line?: LineNumber | null,
  sleepMode = true,
) {
  const event: AlarmEvent = { phaseId, type, stationName };
  return render(
    <SleepAlarmOverlay sleepMode={sleepMode} event={event} onDismiss={mockDismiss} line={line} />,
  );
}

async function triggerModalClose(rendered: ReturnType<typeof renderAlarm>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Modal } = require('react-native');
  await rendered.UNSAFE_getByType(Modal).props.onRequestClose();
}

describe('SleepAlarmOverlay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // #2258 — 취침모드 전용 게이트. store 중앙 게이트(useAlarmEventStore.setAlarmEvent)와
  // 별개로 컴포넌트 자체에도 방어선을 둔다(defense-in-depth). 이 게이트가 없다면 store 게이트를
  // 우회하는 향후 호출부에서 비취침 상태에도 오버레이가 노출되는 #2258이 재발한다.
  it('#2258 sleepMode=false면 아무것도 렌더하지 않는다 (defense-in-depth)', () => {
    const { queryByTestId } = renderAlarm('destination', '강남', 'early', undefined, false);
    expect(queryByTestId('alarm-overlay')).toBeNull();
  });

  it('sleepMode=true + 환승이면 렌더한다', () => {
    const { queryByTestId } = renderAlarm('transfer', '시청', 'early', undefined, true);
    expect(queryByTestId('alarm-overlay')).toBeTruthy();
  });

  it('하차 알림을 표시한다', () => {
    const { getByText, getByTestId } = renderAlarm('destination', '강남');
    expect(getByText('하차 알림')).toBeTruthy();
    expect(getByText('강남에서\n내리세요')).toBeTruthy();
    expect(getByTestId('alarm-overlay-title')).toBeTruthy();
    expect(getByTestId('alarm-overlay-message')).toBeTruthy();
  });

  it('환승 알림을 표시한다', () => {
    const { getByText, getByTestId } = renderAlarm('transfer', '시청');
    expect(getByText('환승 알림')).toBeTruthy();
    expect(getByText('시청에서\n환승하세요')).toBeTruthy();
    expect(getByTestId('alarm-overlay-title')).toBeTruthy();
    expect(getByTestId('alarm-overlay-message')).toBeTruthy();
  });

  it('환승 알람 dismiss → trip 유지. clearAlarmNotification만 호출 (#633)', async () => {
    const { getByTestId } = renderAlarm('transfer', '시청');
    fireEvent.press(getByTestId('alarm-dismiss-button'));
    await waitFor(() => {
      expect(mockClearAlarmNotification).toHaveBeenCalled();
      expect(mockKillAllAlarms).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
    // #673/#806/#741/#746 회귀 가드 — dismiss는 BoardingLock storage를 절대 건드리지 않는다.
    expect(mockGetBoardingLock).not.toHaveBeenCalled();
    expect(mockSetBoardingLock).not.toHaveBeenCalled();
    expect(mockClearBoardingLock).not.toHaveBeenCalled();
  });

  it('#806 도착 알람(early) dismiss → trip 유지. killAllAlarms만 호출, release 트리거 없음', async () => {
    const { getByTestId } = renderAlarm('destination', '강남', 'early');
    fireEvent.press(getByTestId('alarm-dismiss-button'));
    await waitFor(() => {
      expect(mockKillAllAlarms).toHaveBeenCalled();
      expect(mockClearAlarmNotification).not.toHaveBeenCalled();
      expect(mockDismiss).toHaveBeenCalled();
    });
    // #673/#806/#741/#746 회귀 가드 — dismiss는 BoardingLock storage를 절대 건드리지 않는다.
    expect(mockGetBoardingLock).not.toHaveBeenCalled();
    expect(mockSetBoardingLock).not.toHaveBeenCalled();
    expect(mockClearBoardingLock).not.toHaveBeenCalled();
  });

  it('#806 도착 알람(imminent) dismiss → trip 유지. killAllAlarms만 호출', async () => {
    const { getByTestId } = renderAlarm('destination', '강남', 'imminent');
    fireEvent.press(getByTestId('alarm-dismiss-button'));
    await waitFor(() => {
      expect(mockKillAllAlarms).toHaveBeenCalled();
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

  describe('#1289 출구 안내 (StationExitCard) 마운트', () => {
    it('line 미전달 시 출구 안내 섹션이 렌더되지 않는다', () => {
      const { queryByTestId } = renderAlarm('destination', '강남', 'early');
      expect(queryByTestId('alarm-overlay-exit-section')).toBeNull();
    });

    it('line=null 시 출구 안내 섹션이 렌더되지 않는다', () => {
      const { queryByTestId } = renderAlarm('destination', '강남', 'early', null);
      expect(queryByTestId('alarm-overlay-exit-section')).toBeNull();
    });

    it('line 전달 시 출구 안내 섹션이 렌더되고 출구 카드가 나타난다', async () => {
      const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
      const { getByTestId, findByTestId } = render(
        <SleepAlarmOverlay sleepMode event={event} onDismiss={mockDismiss} line="2" />,
      );
      // exit section은 즉시 렌더됨 (line이 있으면)
      expect(getByTestId('alarm-overlay-exit-section')).toBeTruthy();
      // StationExitCard는 MockExitInfoProvider 기본값(강남 2호선 샘플)으로 로드 후 나타남
      await findByTestId('station-exit-card');
    });
  });

  describe('#741 보조 버튼 제거 — 단일 액션 UX', () => {
    it('도착 알람에서 보조 버튼이 노출되지 않는다 (회귀 가드)', () => {
      expect(renderAlarm('destination', '강남').queryByTestId('alarm-keep-trip-button')).toBeNull();
    });

    it('환승 알람에서도 보조 버튼이 노출되지 않는다', () => {
      expect(renderAlarm('transfer', '시청').queryByTestId('alarm-keep-trip-button')).toBeNull();
    });

    it('#806 도착 알람 onRequestClose(Android 백 버튼/스와이프)도 trip 유지', async () => {
      const rendered = renderAlarm('destination', '강남', 'early');
      await triggerModalClose(rendered);
      await waitFor(() => {
        expect(mockKillAllAlarms).toHaveBeenCalled();
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
        expect(mockDismiss).toHaveBeenCalled();
      });
    });
  });
});
