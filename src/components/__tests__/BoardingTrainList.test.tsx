import { fireEvent } from '@testing-library/react-native';
import { BoardingTrainList } from '../BoardingTrainList';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import type { ArrivalInfo } from '../../api/arrivalApi';

function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '상행 종착역',
    arrivalMinutes: 3,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: 'T-1',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('BoardingTrainList', () => {
  it('arrivals 비어있을 때 placeholder 렌더', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[]} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
    expect(getByText('도착 예정 열차가 없습니다.')).toBeTruthy();
  });

  it('각 train마다 trainCode + destination 렌더', () => {
    const trains = [makeTrain({ trainCode: 'T-A', destination: '강남', arrivalMinutes: 2 })];
    const { getByText, getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={trains} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-row-T-A')).toBeTruthy();
    expect(getByText('강남 행')).toBeTruthy();
    expect(getByText('T-A')).toBeTruthy();
  });

  it('#634 도착 시각을 receivedAtMs + arrivalSeconds 기반 HH:mm으로 표시', () => {
    // 2026-01-01 03:05 + 180s = 2026-01-01 03:08
    const base = new Date(2026, 0, 1, 3, 5).getTime();
    const train = makeTrain({ trainCode: 'T-CLOCK', receivedAtMs: base, arrivalSeconds: 180 });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-arrival-T-CLOCK').props.children).toBe('03:08');
  });

  it('#634 receivedAtMs=0(mock/stale)이면 현재 시각 기준 HH:mm 계산', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 0, 1, 10, 0).getTime());
    try {
      const train = makeTrain({ trainCode: 'T-NOW', receivedAtMs: 0, arrivalSeconds: 120 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-arrival-T-NOW').props.children).toBe('10:02');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('train row 탭 시 onSelect에 해당 train 전달', () => {
    const train = makeTrain({ trainCode: 'T-B' });
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
    );
    fireEvent.press(getByTestId('boarding-train-row-T-B'));
    expect(onSelect).toHaveBeenCalledWith(train);
  });

  it('탑승할 열차 선택 헤더 텍스트 표시', () => {
    const { getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[makeTrain()]} line="2" onSelect={() => {}} />,
    );
    expect(getByText('탑승할 열차 선택')).toBeTruthy();
  });

  it('title prop으로 헤더 커스텀 (환승 list 등)', () => {
    const { getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[makeTrain()]} line="2" onSelect={() => {}} title="환승 열차 선택" />,
    );
    expect(getByText('환승 열차 선택')).toBeTruthy();
  });

  it('walkingBufferSeconds 미만 도착 train은 disabled — onSelect 호출 안 됨', () => {
    const tooSoon = makeTrain({ trainCode: 'T-EARLY', arrivalSeconds: 60 });
    const reachable = makeTrain({ trainCode: 'T-OK', arrivalSeconds: 240 });
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[tooSoon, reachable]}
        line="2"
        onSelect={onSelect}
        walkingBufferSeconds={180}
      />,
    );
    fireEvent.press(getByTestId('boarding-train-row-T-EARLY'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.press(getByTestId('boarding-train-row-T-OK'));
    expect(onSelect).toHaveBeenCalledWith(reachable);
  });

  it('#648 SCHED-* trainCode는 사용자에게 숨기고 "시간표" 라벨로 대체', () => {
    const fallback = makeTrain({ trainCode: 'SCHED-DN-1', destination: '석남' });
    const { getByText, queryByText } = renderWithTheme(
      <BoardingTrainList arrivals={[fallback]} line="7" onSelect={() => {}} />,
    );
    expect(queryByText('SCHED-DN-1')).toBeNull();
    expect(getByText('시간표')).toBeTruthy();
    expect(getByText('석남 행')).toBeTruthy();
  });

  it('walkingBufferSeconds 미전달이면 모든 train 활성', () => {
    const tooSoon = makeTrain({ trainCode: 'T-EARLY', arrivalSeconds: 60 });
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[tooSoon]} line="2" onSelect={onSelect} />,
    );
    fireEvent.press(getByTestId('boarding-train-row-T-EARLY'));
    expect(onSelect).toHaveBeenCalled();
  });
});
