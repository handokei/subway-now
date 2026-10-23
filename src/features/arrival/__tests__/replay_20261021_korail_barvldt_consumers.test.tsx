/* eslint-disable import/no-restricted-paths --
 * #3132 소비자 gate. unknown ETA(arrivalSeconds=null)가 흘러가는 모든 표시·필터·정렬 소비자를 한 파일에서
 * 증명하려면 arrival/alarm/route 슬라이스를 직접 import해야 한다. test-only.
 */
/**
 * #3132 — 코레일 `barvlDt=0` unknown ETA 소비자 동작. 입력 행은 10/21 서울숲 실측(`서울숲.json`)과
 * 동형(arvlMsg2 / arvlCd / barvlDt)이다.
 */
import { act, renderHook } from '@testing-library/react-native';
import { useArrivalCountdown } from '../hooks/useArrivalCountdown';
import { pickArrivalAtOrigin } from '../utils/pickArrivalAtOrigin';
import { findTrainFeedEtaSeconds } from '../utils/trainFeedEta';
import { pickNextTrainMinutes } from '../utils/nextTrainMinutes';
import { arrivalInfoToArrivalTrain } from '../../route/utils/journeyAdapter';
import { filterArrivalsByDirection } from '../../route/hooks/useTransferTrainList';
import { BoardingTrainList } from '../../alarm/components/BoardingTrainList';
import { EditorialArrivalRow } from '../components/EditorialArrivalRow';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

function row(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '왕십리행 - 왕십리방면',
    arrivalSeconds: null,
    stopsAway: null,
    statusMessage: '',
    trainCode: 'T',
    line: 'bundang',
    receivedAtMs: 1_000,
    arrivalCode: 99,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

// 서울숲 상행 실측 3행과 동형.
const ARRIVED = row({ trainCode: '6546', arrivalSeconds: 0, arrivalCode: 1, statusMessage: '서울숲 도착', locationStation: '서울숲' });
const FAR_3 = row({ trainCode: '6112', arrivalSeconds: null, stopsAway: 3, statusMessage: '[3]번째 전역 (선정릉)', locationStation: '선정릉' });
const PREV_1 = row({ trainCode: '6139', arrivalSeconds: null, stopsAway: 1, arrivalCode: 5, statusMessage: '전역 도착', locationStation: '왕십리' });
const FAR_9 = row({ trainCode: '6200', arrivalSeconds: null, stopsAway: 9, statusMessage: '[9]번째 전역 (한티)', locationStation: '한티' });
const SEC_240 = row({ trainCode: '7000', arrivalSeconds: 240, statusMessage: '4분 후', arrivalCode: 99 });

describe('useArrivalCountdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('null은 감산되지 않고 null로 유지, 숫자 행은 그대로 1초씩 감소', () => {
    const arrival: StationArrival = { up: [FAR_3, SEC_240], down: [] };
    const { result } = renderHook(() => useArrivalCountdown(arrival));
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(result.current!.up[0].arrivalSeconds).toBeNull();
    expect(result.current!.up[1].arrivalSeconds).toBe(237);
  });
});

describe('pickArrivalAtOrigin', () => {
  it('첫 행이 unknown이면 그 방향은 후보에서 제외 — 다른 방향 실값을 고른다', () => {
    const arrival: StationArrival = { up: [FAR_3], down: [row({ trainCode: 'D', arrivalSeconds: 300 })] };
    expect(pickArrivalAtOrigin(arrival)).toEqual({ arrivalSeconds: 300, receivedAtMs: 1_000 });
  });

  it('양방향 첫 행이 모두 unknown이면 undefined (DEFAULT_WAIT_MINUTES graceful fallback)', () => {
    expect(pickArrivalAtOrigin({ up: [FAR_3], down: [PREV_1] })).toBeUndefined();
  });
});

describe('findTrainFeedEtaSeconds', () => {
  it('매칭 행이 unknown이면 null (지어낸 0초 금지 → 호출자 GPS 폴백)', () => {
    expect(findTrainFeedEtaSeconds({ up: [FAR_3], down: [] }, '6112')).toBeNull();
  });
});

describe('arrivalInfoToArrivalTrain (홈 EditorialArrivalRow 입력)', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000));
  afterEach(() => jest.restoreAllMocks());

  it('unknown → arrivalAtMs null + positionLabel(큰 글씨/작은 글씨), 중복 subtext 없음', () => {
    const [train] = arrivalInfoToArrivalTrain([FAR_3], '왕십리', 'bundang');
    expect(train.arrivalAtMs).toBeNull();
    expect(train.positionLabel).toEqual({ primary: '3번째 전역', secondary: '선정릉' });
    expect(train.subtext).toBeUndefined();
  });

  it('known(서울교통공사 일반 행) 은 기존 그대로: arrivalAtMs=now+초, subtext=원문, positionLabel 없음', () => {
    const [train] = arrivalInfoToArrivalTrain([SEC_240], '왕십리', 'bundang');
    expect(train.arrivalAtMs).toBe(1_700_000_000_000 + 240_000);
    expect(train.subtext).toBe('4분 후');
    expect(train.positionLabel).toBeUndefined();
  });

  it('정렬: 초 있는 행 → stopsAway 오름차순 → 맨 뒤, 행은 하나도 빠지지 않는다', () => {
    const trains = arrivalInfoToArrivalTrain([FAR_9, FAR_3, SEC_240, PREV_1, ARRIVED], '왕십리', 'bundang');
    expect(trains).toHaveLength(5);
    expect(trains.map((t) => t.positionLabel?.primary ?? 'known')).toEqual([
      'known', // 240 (입력 순서 유지)
      '도착', // 도착 0 — 상태 라벨 (#3132 잔여), known 그룹 안 위치는 그대로
      '전역 도착',
      '3번째 전역',
      '9번째 전역',
    ]);
  });
});

describe('EditorialArrivalRow', () => {
  it('positionLabel이 있으면 mm:ss 대신 큰 글씨 primary + 작은 글씨 secondary', () => {
    const { getByText, queryByText } = renderWithTheme(
      <EditorialArrivalRow
        train={{
          direction: '왕십리행',
          line: 'bundang',
          arrivalAtMs: null,
          positionLabel: { primary: '3번째 전역', secondary: '선정릉' },
        }}
      />,
    );
    expect(getByText('3번째 전역')).toBeTruthy();
    expect(getByText('선정릉')).toBeTruthy();
    expect(queryByText('00')).toBeNull();
  });
});

describe('filterArrivalsByDirection (환승 목록)', () => {
  it('unknown 행은 제외하지 않는다. 진입/도착 0초 행의 기존 제외 정책은 그대로', () => {
    const out = filterArrivalsByDirection({ up: [ARRIVED, FAR_3, SEC_240], down: [PREV_1] }, null);
    expect(out.map((t) => t.trainCode)).toEqual(['6112', '7000', '6139']);
  });
});

describe('BoardingTrainList', () => {
  it('unknown 행: 피드 문구 표시, 도착 예정 시각 라인 없음, walkingBuffer로 unreachable 처리되지 않음, 정렬', () => {
    const { getByTestId, queryByTestId, getAllByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[FAR_9, FAR_3, SEC_240]}
        line="bundang"
        onSelect={() => {}}
        walkingBufferSeconds={120}
      />,
    );
    // 240초 행(known)이 먼저, 이어서 3번째 전역, 9번째 전역.
    const rendered = getAllByTestId(/^boarding-train-row-/).map((n) => n.props.testID);
    expect(rendered).toEqual(['boarding-train-row-7000', 'boarding-train-row-6112', 'boarding-train-row-6200']);
    expect(getByTestId('boarding-train-sequence-6112').props.children).toBe('3번째 전역 (선정릉)');
    expect(queryByTestId('boarding-train-arrival-6112')).toBeNull();
    expect(getByTestId('boarding-train-row-6112').props.accessibilityState?.disabled).not.toBe(true);
  });
});

describe('pickNextTrainMinutes (홈 ETA 입력, HomeScreen nextTrainMinutes)', () => {
  it('서울교통공사 동작 불변: 양방향 첫 행 중 최소 분', () => {
    const arrival: StationArrival = {
      up: [row({ trainCode: 'U', arrivalSeconds: 300 })],
      down: [row({ trainCode: 'D', arrivalSeconds: 130 })],
    };
    expect(pickNextTrainMinutes(arrival)).toBe(2);
  });

  it('청량리 1001 상행처럼 첫 행이 unknown이면 그 방향은 Infinity (예전의 0분 "지금 도착" 오표기 제거)', () => {
    const arrival: StationArrival = { up: [FAR_3, SEC_240], down: [] };
    expect(pickNextTrainMinutes(arrival)).toBe(Infinity);
  });

  it('한 방향이 unknown이어도 다른 방향 실값이 있으면 그 값', () => {
    const arrival: StationArrival = { up: [FAR_3], down: [SEC_240] };
    expect(pickNextTrainMinutes(arrival)).toBe(4);
  });
});

describe('BoardingTrainList — 시간 모름 보조 케이스', () => {
  it('역명이 없는 unknown 행은 괄호 없이 위치 문구만', () => {
    const noStation = row({ trainCode: 'N1', stopsAway: 1, arrivalCode: 5, statusMessage: '전역 도착' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[noStation]} line="bundang" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-sequence-N1').props.children).toBe('전역 도착');
  });

  it('unknown 행만 있으면 지연 칩 기준(가장 가까운 도착)이 없어 칩 미노출', () => {
    const { queryByText } = renderWithTheme(
      <BoardingTrainList arrivals={[FAR_3]} line="bundang" onSelect={() => {}} initialEtaSeconds={60} />,
    );
    expect(queryByText(/지연/)).toBeNull();
  });

  it('known 행과 섞이면 unknown은 지연 계산에서 제외 — known 행만으로 칩 판정', () => {
    const late = row({ trainCode: 'L1', arrivalSeconds: 600 });
    const { queryByText } = renderWithTheme(
      <BoardingTrainList arrivals={[FAR_3, late]} line="bundang" onSelect={() => {}} initialEtaSeconds={60} />,
    );
    expect(queryByText(/\+9/)).toBeTruthy(); // (600-60)/60 = 9분
  });
});
