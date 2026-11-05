import { fireEvent } from '@testing-library/react-native';
import { BoardingTrainList } from '../BoardingTrainList';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { DepartedTrainRow } from '../../utils/departedTrainRows';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '성수행',
    stopsAway: null,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: '3013',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

// trip 171: 2011은 06:36:28 건대입구 출발. 목록 첫 행(접근 중)은 다음 열차 3013이었다.
function makeDeparted(trainCode: string, departedAtMs: number, currentStation: string | null): DepartedTrainRow {
  return {
    train: makeTrain({ trainCode, arrivalSeconds: null, arrivalCode: 2, receivedAtMs: departedAtMs }),
    departedAtMs,
    currentStation,
  };
}

const T_2011 = new Date(2026, 9, 20, 6, 36, 28).getTime();
const T_2007 = new Date(2026, 9, 20, 6, 33, 10).getTime();

describe('BoardingTrainList — 이미 출발 섹션 (#3155)', () => {
  it('departedTrains를 접근 중 목록 아래 "이미 출발" 섹션으로, 최근 출발 순으로 렌더한다', () => {
    const { getByTestId, getByText, getAllByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        departedTrains={[makeDeparted('2007', T_2007, '구의'), makeDeparted('2011', T_2011, '성수')]}
      />,
    );
    expect(getByTestId('boarding-train-row-3013')).toBeTruthy();
    expect(getByText('이미 출발')).toBeTruthy();
    const rows = getAllByTestId(/^boarding-train-departed-row-/);
    expect(rows.map((r) => r.props.testID)).toEqual([
      'boarding-train-departed-row-2011',
      'boarding-train-departed-row-2007',
    ]);
  });

  it('행에 출발 시각과 지금 있는 역을 "06:36 출발 · 지금 성수"로 표시한다', () => {
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        departedTrains={[makeDeparted('2011', T_2011, '성수')]}
      />,
    );
    expect(getByTestId('boarding-train-departed-sequence-2011').props.children).toBe('06:36 출발 · 지금 성수');
  });

  it('지금 역을 모르면 "06:36 출발"만 표시한다', () => {
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        departedTrains={[makeDeparted('2011', T_2011, null)]}
      />,
    );
    expect(getByTestId('boarding-train-departed-sequence-2011').props.children).toBe('06:36 출발');
  });

  it('출발 행을 탭하면 그 열차의 trainCode로 기존 onSelect(수동 탭 경로)가 호출된다', () => {
    const onSelect = jest.fn();
    const departed = makeDeparted('2011', T_2011, '성수');
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[makeTrain()]} line="2" onSelect={onSelect} departedTrains={[departed]} />,
    );
    fireEvent.press(getByTestId('boarding-train-departed-row-2011'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ trainCode: '2011', line: '2' });
  });

  it('필드 부재(departedTrains 미전달/빈 배열)면 섹션이 없고 기존 렌더 그대로', () => {
    const { queryByText, queryByTestId, rerender } = renderWithTheme(
      <BoardingTrainList arrivals={[makeTrain()]} line="2" onSelect={() => {}} />,
    );
    expect(queryByText('이미 출발')).toBeNull();
    expect(queryByTestId('boarding-train-row-3013')).toBeTruthy();
    rerender(<BoardingTrainList arrivals={[makeTrain()]} line="2" onSelect={() => {}} departedTrains={[]} />);
    expect(queryByText('이미 출발')).toBeNull();
  });

  it('접근 중 열차가 하나도 없어도 출발 행이 있으면 empty placeholder 대신 섹션을 렌더한다', () => {
    const { queryByTestId, getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[]}
        line="2"
        onSelect={() => {}}
        departedTrains={[makeDeparted('2011', T_2011, '성수')]}
      />,
    );
    expect(queryByTestId('boarding-train-list-empty')).toBeNull();
    expect(getByTestId('boarding-train-departed-row-2011')).toBeTruthy();
  });

  it('consensus 제안 열차가 출발 섹션에 있으면 "다음 열차 추적 중" 배지를 따로 띄우지 않고 그 행에 "추정" 배지를 단다', () => {
    const { queryByTestId, getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        consensusSuggestion={{ trainCode: '2011' }}
        departedTrains={[makeDeparted('2011', T_2011, '성수')]}
      />,
    );
    expect(queryByTestId('boarding-train-list-consensus-tracking')).toBeNull();
    expect(getByTestId('boarding-train-departed-consensus-badge-2011')).toBeTruthy();
  });

  it('device prevTrain(전열차)과 같은 열차가 출발 섹션에 있으면 전열차 행은 중복 노출하지 않는다', () => {
    const { queryByTestId, getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        prevTrain={{ train: makeTrain({ trainCode: '2011' }), elapsedSeconds: 30, arrivedAtMs: null }}
        departedTrains={[makeDeparted('2011', T_2011, '성수')]}
      />,
    );
    expect(queryByTestId('boarding-train-prev-row-2011')).toBeNull();
    expect(getByTestId('boarding-train-departed-row-2011')).toBeTruthy();
  });
});
