/**
 * #3100 PR-5 — MAX=4 변형: 행 수·선택 가능 범위가 상수에서 파생됨을 증명한다(리터럴 `[1,2,3]` 하드코딩이면 red).
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { SleepAlarmStops } from '../SleepAlarmStops';
import { useSettingsStore } from '../../store/useSettingsStore';

const MOCK_MAX = 4;

jest.mock('../../../../shared/constants/sleepAlarm', () => ({
  ...jest.requireActual('../../../../shared/constants/sleepAlarm'),
  SLEEP_ALARM_MAX_STOPS_BEFORE: 4,
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../../../shared/infra/monitoring/sentryInit', () => ({
  getSentryOptIn: jest.fn().mockResolvedValue(false),
  setSentryOptIn: jest.fn().mockResolvedValue(undefined),
}));

describe('SleepAlarmStops — MAX=4', () => {
  beforeEach(() => useSettingsStore.setState({ sleepAlarm: undefined }));

  it('행이 MAX(4)개이고 최대 칸도 선택·저장된다', async () => {
    renderWithTheme(<SleepAlarmStops />);
    expect(screen.getAllByTestId(/^sleep-alarm-row-/)).toHaveLength(MOCK_MAX);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`sleep-alarm-row-${MOCK_MAX}`));
    });
    expect(useSettingsStore.getState().sleepAlarm).toEqual({ mode: 'selected', stops: [MOCK_MAX, 1] });
  });
});
