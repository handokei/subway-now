/**
 * #3100 PR-5 — 설정 > 취침 모드 > "N역 전부터" 알람 칸 선택 UI.
 * 기본 표시 = 선택한 역에서만 + 1역 전만 체크(= 저장값 없음). 행 수는 상수(MAX)에서 파생된다.
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { SleepAlarmStops } from '../SleepAlarmStops';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  SLEEP_ALARM_MAX_STOPS_BEFORE,
  SLEEP_ALARM_MIN_STOPS_BEFORE,
} from '../../../../shared/constants/sleepAlarm';
import { sleepAlarmStopOptions } from '../../../../shared/utils/sleepAlarmCells';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../../../shared/infra/monitoring/sentryInit', () => ({
  getSentryOptIn: jest.fn().mockResolvedValue(false),
  setSentryOptIn: jest.fn().mockResolvedValue(undefined),
}));

const MIN = SLEEP_ALARM_MIN_STOPS_BEFORE;
const MAX = SLEEP_ALARM_MAX_STOPS_BEFORE;
const ROWS = sleepAlarmStopOptions();
// 기본값(MIN)과 다르게 만드는 비기본 칸 — 상수 파생.
const OTHER = MAX;

const row = (n: number) => screen.getByTestId(`sleep-alarm-row-${n}`);
const checked = (n: number) => row(n).props.accessibilityState?.checked === true;
const disabled = (n: number) => row(n).props.accessibilityState?.disabled === true;
const stored = () => useSettingsStore.getState().sleepAlarm;
const press = async (el: unknown) => {
  await act(async () => {
    fireEvent.press(el as never);
  });
};

describe('SleepAlarmStops (#3100 PR-5)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sleepAlarm: undefined });
    jest.clearAllMocks();
  });

  it('행 수는 MAX - MIN + 1 이고 "N역 전부터" 라벨을 쓴다', () => {
    renderWithTheme(<SleepAlarmStops />);
    expect(ROWS).toHaveLength(MAX - MIN + 1);
    for (const n of ROWS) {
      expect(row(n)).toBeTruthy();
      expect(screen.getByText(`${n}역 전부터`)).toBeTruthy();
    }
  });

  it('기본 표시: 선택한 역에서만 + MIN만 체크, 마지막 선택 칸이라 MIN은 해제 불가', () => {
    renderWithTheme(<SleepAlarmStops />);
    expect(screen.getByTestId('sleep-alarm-mode-selected').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('sleep-alarm-mode-every').props.accessibilityState.selected).toBe(false);
    expect(ROWS.filter(checked)).toEqual([MIN]);
    expect(disabled(MIN)).toBe(true);
  });

  it('선택 모드: 다중 체크 가능하고 저장은 내림차순 normalize', async () => {
    renderWithTheme(<SleepAlarmStops />);
    await press(row(OTHER));
    expect(stored()).toEqual({ mode: 'selected', stops: [OTHER, MIN] });
    expect(ROWS.filter(checked)).toEqual([OTHER, MIN]);
  });

  it('선택 모드: 체크 해제 가능, 마지막 칸은 눌러도 저장이 바뀌지 않는다(빈 선택 방지)', async () => {
    useSettingsStore.setState({ sleepAlarm: { mode: 'selected', stops: [OTHER, MIN] } });
    renderWithTheme(<SleepAlarmStops />);
    await press(row(OTHER));
    expect(stored()).toBeUndefined(); // {selected,[MIN]} = 기본값 = undefined
    expect(ROWS.filter(checked)).toEqual([MIN]);
    await press(row(MIN));
    expect(ROWS.filter(checked)).toEqual([MIN]);
    expect(stored()).toBeUndefined();
  });

  it('매 역 모드: 시작 N 하나만(라디오) — 다른 행을 누르면 교체되고 다중이 되지 않는다', async () => {
    renderWithTheme(<SleepAlarmStops />);
    await press(screen.getByTestId('sleep-alarm-mode-every'));
    expect(screen.getByTestId('sleep-alarm-mode-every').props.accessibilityState.selected).toBe(true);
    await press(row(OTHER));
    expect(stored()).toEqual({ mode: 'every', stops: [OTHER] });
    expect(ROWS.filter(checked)).toEqual([OTHER]);
    expect(row(OTHER).props.accessibilityRole).toBe('radio');
    // 더 가까운 칸을 누르면 시작 N이 그 칸으로 교체된다(누적 X)
    await press(row(MIN));
    expect(ROWS.filter(checked)).toEqual([MIN]);
    expect(stored()).toBeUndefined();
  });

  it('매 역 + MIN은 기본값과 같아 저장은 비우되 모드 표시는 유지한다', async () => {
    renderWithTheme(<SleepAlarmStops />);
    await press(screen.getByTestId('sleep-alarm-mode-every'));
    expect(stored()).toBeUndefined();
    expect(screen.getByTestId('sleep-alarm-mode-every').props.accessibilityState.selected).toBe(true);
  });

  it('모드 전환: 선택(다중) -> 매 역은 가장 먼 칸 하나, 매 역 -> 선택은 그 칸 하나', async () => {
    useSettingsStore.setState({ sleepAlarm: { mode: 'selected', stops: [OTHER, MIN] } });
    renderWithTheme(<SleepAlarmStops />);
    await press(screen.getByTestId('sleep-alarm-mode-every'));
    expect(stored()).toEqual({ mode: 'every', stops: [OTHER] });
    await press(screen.getByTestId('sleep-alarm-mode-selected'));
    expect(stored()).toEqual({ mode: 'selected', stops: [OTHER] });
  });

  it('저장된 매 역 설정이 외부에서 바뀌면 모드 표시가 따라간다', () => {
    renderWithTheme(<SleepAlarmStops />);
    act(() => {
      useSettingsStore.setState({ sleepAlarm: { mode: 'every', stops: [OTHER] } });
    });
    expect(screen.getByTestId('sleep-alarm-mode-every').props.accessibilityState.selected).toBe(true);
    expect(ROWS.filter(checked)).toEqual([OTHER]);
  });

  it('선택 모드 보조 문구(칸마다 1회 / 짧은 구간은 출발역 다음 역)를 보여준다', () => {
    renderWithTheme(<SleepAlarmStops />);
    expect(
      screen.getByText('체크한 칸마다 한 번씩 울립니다. 구간이 짧으면 출발역 다음 역에서 울립니다.'),
    ).toBeTruthy();
  });

  it('매 역 모드 보조 문구는 시작 N을 보간한다', () => {
    useSettingsStore.setState({ sleepAlarm: { mode: 'every', stops: [OTHER] } });
    renderWithTheme(<SleepAlarmStops />);
    expect(screen.getByText(`${OTHER}역 전부터 도착 직전까지 매 역 울립니다.`)).toBeTruthy();
  });

  it('disabled(취침 OFF): 모든 컨트롤 비활성, 눌러도 저장값 유지', async () => {
    useSettingsStore.setState({ sleepAlarm: { mode: 'selected', stops: [OTHER, MIN] } });
    renderWithTheme(<SleepAlarmStops disabled />);
    for (const n of ROWS) expect(disabled(n)).toBe(true);
    expect(screen.getByTestId('sleep-alarm-mode-every').props.accessibilityState.disabled).toBe(true);
    await press(row(MIN));
    await press(screen.getByTestId('sleep-alarm-mode-every'));
    expect(stored()).toEqual({ mode: 'selected', stops: [OTHER, MIN] });
    expect(ROWS.filter(checked)).toEqual([OTHER, MIN]);
  });

  it('a11y: 행 라벨 + 역할, 마지막 선택 칸 힌트', () => {
    renderWithTheme(<SleepAlarmStops />);
    expect(row(MIN).props.accessibilityLabel).toBe(`${MIN}역 전부터`);
    expect(row(MIN).props.accessibilityRole).toBe('checkbox');
    expect(row(MIN).props.accessibilityHint).toBe('마지막 선택 칸은 해제할 수 없습니다');
  });
});
