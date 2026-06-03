import { fireEvent } from '@testing-library/react-native';
import { BoardingTrainList } from '../BoardingTrainList';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import { LINE_COLORS } from '../../constants/lineColors';
import type { ArrivalInfo } from '../../api/arrivalApi';

function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '상행 종착역',
    arrivalMinutes: 3,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: 'T-1',
    line: '2',
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

  it('#749 각 train마다 종착(○○행) 표기 + 카운터 + 시각', () => {
    // destination은 Seoul API trainLineNm 원본 포맷(예: "강남행"). #792에서 parseTrainLineDirection으로
    // 정규화하므로 기존 raw 값을 그대로 전달.
    const trains = [makeTrain({ trainCode: 'T-A', destination: '강남행', arrivalMinutes: 2 })];
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={trains} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-row-T-A')).toBeTruthy();
    expect(getByTestId('boarding-train-meta-T-A').props.children).toBe('강남행');
    expect(getByTestId('boarding-train-sequence-T-A').props.children).toBe('1번째 전');
  });

  it('#634 도착 시각을 receivedAtMs + arrivalSeconds 기반 HH:mm으로 표시', () => {
    // 2026-01-01 03:05 + 180s = 2026-01-01 03:08
    const base = new Date(2026, 0, 1, 3, 5).getTime();
    const train = makeTrain({ trainCode: 'T-CLOCK', receivedAtMs: base, arrivalSeconds: 180 });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-arrival-T-CLOCK').props.children).toBe('03:08 도착 예정');
  });

  it('#634 receivedAtMs=0(mock/stale)이면 현재 시각 기준 HH:mm 계산', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 0, 1, 10, 0).getTime());
    try {
      const train = makeTrain({ trainCode: 'T-NOW', receivedAtMs: 0, arrivalSeconds: 120 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-arrival-T-NOW').props.children).toBe('10:02 도착 예정');
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
    const fallback = makeTrain({ trainCode: 'SCHED-DN-1', destination: '석남행', line: '7' });
    const { getByText, queryByText, getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[fallback]} line="7" onSelect={() => {}} />,
    );
    expect(queryByText('SCHED-DN-1')).toBeNull();
    expect(getByText('시간표')).toBeTruthy();
    expect(getByTestId('boarding-train-meta-SCHED-DN-1').props.children).toBe('석남행');
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

  it('#749 nextStationLabel 전달 시 종착 + 방면 동시 표시 ("○○행 · ○○방면")', () => {
    const train = makeTrain({ trainCode: 'T-NEXT', destination: '석남행', line: '7' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[train]}
        line="7"
        onSelect={() => {}}
        nextStationLabel="중곡"
      />,
    );
    expect(getByTestId('boarding-train-meta-T-NEXT').props.children).toBe('석남행 · 중곡방면');
  });

  it('#749 nextStationLabel null이면 종착만 표시 (방면 생략)', () => {
    const train = makeTrain({ trainCode: 'T-NO-NEXT', destination: '석남행', line: '7' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[train]}
        line="7"
        onSelect={() => {}}
        nextStationLabel={null}
      />,
    );
    expect(getByTestId('boarding-train-meta-T-NO-NEXT').props.children).toBe('석남행');
  });

  it('#749 시퀀스 카운터는 arrivalSeconds 오름차순 정렬 후 1-indexed', () => {
    // arrivals 입력 순서가 정렬 순서가 아니어도 카운터는 도착 시간 빠른 순부터.
    // 정렬은 호출자 책임이라 동일 순서로 전달되었을 때의 카운터 매핑을 검증한다.
    const trains = [
      makeTrain({ trainCode: 'T-1ST', arrivalSeconds: 60 }),
      makeTrain({ trainCode: 'T-2ND', arrivalSeconds: 180 }),
      makeTrain({ trainCode: 'T-3RD', arrivalSeconds: 300 }),
    ];
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={trains} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-sequence-T-1ST').props.children).toBe('1번째 전');
    expect(getByTestId('boarding-train-sequence-T-2ND').props.children).toBe('2번째 전');
    expect(getByTestId('boarding-train-sequence-T-3RD').props.children).toBe('3번째 전');
  });

  it('#749 compact 모드: 헤더/trainCode 라인 생략, 단일 row 종착·방면 라벨', () => {
    const train = makeTrain({ trainCode: 'T-COMPACT', destination: '석남행', line: '7' });
    const { getByTestId, queryByText } = renderWithTheme(
      <BoardingTrainList
        arrivals={[train]}
        line="7"
        onSelect={() => {}}
        compact
        nextStationLabel="중곡"
      />,
    );
    expect(getByTestId('boarding-train-meta-T-COMPACT').props.children).toBe('석남행 · 중곡방면');
    expect(queryByText('탑승할 열차 선택')).toBeNull();
    expect(queryByText('T-COMPACT')).toBeNull();
  });

  it('#749 compact 모드에서도 카운터 + 시각 표기', () => {
    const train = makeTrain({ trainCode: 'T-CO-SEQ', destination: '석남행', line: '7' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[train]}
        line="7"
        onSelect={() => {}}
        compact
        nextStationLabel="중곡"
      />,
    );
    expect(getByTestId('boarding-train-sequence-T-CO-SEQ').props.children).toBe('1번째 전');
    expect(getByTestId('boarding-train-arrival-T-CO-SEQ')).toBeTruthy();
  });

  it('#649 compact + 빈 arrivals 도 동일 placeholder', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[]} line="7" onSelect={() => {}} compact />,
    );
    expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
    expect(getByText('도착 예정 열차가 없습니다.')).toBeTruthy();
  });

  describe('#792 종착/방면 라벨 중복 제거', () => {
    it('destination "어린이대공원(세종대)방면" + nextStationLabel "어린이대공원" → 접미사 생략 (중복 차단)', () => {
      const train = makeTrain({
        trainCode: 'T-DEDUP',
        destination: '어린이대공원(세종대)방면',
        line: '7',
      });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="7"
          onSelect={() => {}}
          nextStationLabel="어린이대공원"
        />,
      );
      expect(getByTestId('boarding-train-meta-T-DEDUP').props.children).toBe(
        '어린이대공원(세종대)방면',
      );
    });

    it('destination "내선순환"은 parseTrainLineDirection으로 정규화되어 "행" 미부착', () => {
      const train = makeTrain({ trainCode: 'T-LOOP', destination: '내선순환', line: '2' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-meta-T-LOOP').props.children).toBe('내선순환');
    });

    it('destination "도봉산행"은 정규화 결과 그대로 표기, 다른 nextStationLabel은 정상 부착', () => {
      const train = makeTrain({ trainCode: 'T-NORMAL', destination: '도봉산행', line: '7' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="7"
          onSelect={() => {}}
          nextStationLabel="중곡"
        />,
      );
      expect(getByTestId('boarding-train-meta-T-NORMAL').props.children).toBe('도봉산행 · 중곡방면');
    });

    it('substring false-positive 방지: "도봉산행" + "도봉" → terminal 정확비교라 정상 부착', () => {
      // 1호선 망월사 시뮬레이션. P1-1: 이전 includes() 기반 dedup은 false-positive로 "도봉산행"만 표시했음.
      const train = makeTrain({ trainCode: 'T-PREFIX', destination: '도봉산행', line: '1' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="1"
          onSelect={() => {}}
          nextStationLabel="도봉"
        />,
      );
      expect(getByTestId('boarding-train-meta-T-PREFIX').props.children).toBe('도봉산행 · 도봉방면');
    });
  });

  describe('#664 환승역 line 필터 + 호선 색 stripe', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
      if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
      return (style ?? {}) as Record<string, unknown>;
    }

    it('train.line이 헤더 line과 다른 row는 표시되지 않는다 (환승역 같은 statnNm 다른 노선)', () => {
      const trains = [
        makeTrain({ trainCode: 'T-7', line: '7' }),
        makeTrain({ trainCode: 'T-G', line: 'gyeongui' }),
      ];
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={trains} line="7" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-row-T-7')).toBeTruthy();
      expect(queryByTestId('boarding-train-row-T-G')).toBeNull();
    });

    it('모든 row가 헤더 line과 불일치하면 empty placeholder', () => {
      const trains = [makeTrain({ trainCode: 'T-G', line: 'gyeongui' })];
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={trains} line="7" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
    });

    it('row 좌측에 호선 색 stripe (borderLeftColor = LINE_COLORS[train.line])', () => {
      const train = makeTrain({ trainCode: 'T-7', line: '7' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="7" onSelect={() => {}} />,
      );
      const row = getByTestId('boarding-train-row-T-7');
      const style = flattenStyle(row.props.style);
      expect(style.borderLeftColor).toBe(LINE_COLORS['7']);
      expect(style.borderLeftWidth).toBeGreaterThan(0);
    });

    it('compact 모드에서도 stripe 적용', () => {
      const train = makeTrain({ trainCode: 'T-COMPACT-7', line: '7' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="7" onSelect={() => {}} compact />,
      );
      const row = getByTestId('boarding-train-row-T-COMPACT-7');
      const style = flattenStyle(row.props.style);
      expect(style.borderLeftColor).toBe(LINE_COLORS['7']);
    });
  });
});
