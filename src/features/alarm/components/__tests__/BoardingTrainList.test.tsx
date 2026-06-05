import { fireEvent } from '@testing-library/react-native';
import { BoardingTrainList } from '../BoardingTrainList';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { LINE_COLORS } from '../../../../shared/constants/lineColors';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { LineNumber } from '../../../../shared/types/station';

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
    // #855: statusMessage 빈 경우 fallback 라벨 "약 N정거장 전 (약 M분 후)" — arrivalSeconds=180 → 3분.
    expect(getByTestId('boarding-train-sequence-T-A').props.children).toBe('약 1정거장 전 (약 3분 후)');
  });

  it('#897 Seam A: 도착 시각은 현재 시각 + arrivalSeconds 기반 HH:mm으로 표시', () => {
    // #897: anchor를 receivedAtMs+arrivalSeconds → Date.now()+arrivalSeconds로 통일.
    // useArrivalCountdown tick(1초마다 arrivalSeconds-1)과 시계 흐름이 동기화돼 stable.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 0, 1, 3, 5).getTime());
    try {
      // receivedAtMs 값에 관계없이 (지금 + 180s) 기준 HH:mm.
      const train = makeTrain({ trainCode: 'T-CLOCK', receivedAtMs: 0, arrivalSeconds: 180 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-arrival-T-CLOCK').props.children).toBe('03:08 도착 예정');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('#897 Seam A: receivedAtMs 과거 값이어도 anchor는 현재 시각 — useArrivalCountdown tick과 stable', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 0, 1, 10, 0).getTime());
    try {
      // receivedAtMs가 1시간 전이라도 표시 시각은 (지금=10:00) + 120s = 10:02.
      const stale = new Date(2026, 0, 1, 9, 0).getTime();
      const train = makeTrain({ trainCode: 'T-STALE', receivedAtMs: stale, arrivalSeconds: 120 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-arrival-T-STALE').props.children).toBe('10:02 도착 예정');
    } finally {
      nowSpy.mockRestore();
    }
  });

  describe('#897 Seam A — initialEtaSeconds 지연 칩', () => {
    it('arrivalSeconds 차이 < 임계치(180s) → 칩 미노출', () => {
      const train = makeTrain({ trainCode: 'T-OK', arrivalSeconds: 240 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={120}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('차이 = 정확히 임계치 → 칩 노출 (diff < THRESHOLD가 거짓이므로 분기 진입)', () => {
      // 120 + 180 = 300. diff=180. `diff < 180` false → 칩 노출 + ceil(180/60)=3.
      const train = makeTrain({ trainCode: 'T-EDGE', arrivalSeconds: 300 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={120}
        />,
      );
      expect(getByTestId('boarding-train-delay-chip').props.children).toBeDefined();
    });

    it('arrivals 정렬 안 됨 → 가장 빠른 arrival 기준 (호출자 정렬 무관)', () => {
      // 정렬되지 않은 입력: [400s, 90s]. nearest=90s. initial=60 → diff=30 < 180 → 칩 미노출.
      // 정렬을 못 한 호출자가 첫 row를 nearest로 잘못 잡으면 diff=340 → "+6분 지연" 오발화하지 않음.
      const slow = makeTrain({ trainCode: 'T-SLOW', arrivalSeconds: 400 });
      const fast = makeTrain({ trainCode: 'T-FAST', arrivalSeconds: 90 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[slow, fast]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={60}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('arrivals 오름차순 입력 → 첫 row가 nearest로 유지 (reduce keep-min 분기)', () => {
      // [90s, 400s]. first=90s. cur=400s, 400<90 false → min(90) 유지. diff=90-60=30 < 180 → 미노출.
      const fast = makeTrain({ trainCode: 'T-FAST', arrivalSeconds: 90 });
      const slow = makeTrain({ trainCode: 'T-SLOW', arrivalSeconds: 400 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[fast, slow]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={60}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('initialEtaSeconds=0 (임박 열차를 탭한 lock) → 칩 미노출 (baseline 0은 비교 의미 없음)', () => {
      // 사용자가 arrivalSeconds=0 train을 탭해 initialEtaSeconds=0인 lock 생성.
      // 다음 폴에 같은 trainCode가 캐시 재출현으로 300s 잡혀도 false positive 발사하지 않음.
      const train = makeTrain({ trainCode: 'T-IMM', arrivalSeconds: 300 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={0}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('차이 >= 임계치(180s) → "+N분 지연" 칩 노출 (ceil)', () => {
      // initial 60s → 현재 240s. diff=180s → ceil(180/60)=3분.
      const train = makeTrain({ trainCode: 'T-DELAY', arrivalSeconds: 240 });
      const { getByText } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={60}
        />,
      );
      expect(getByText('+3분 지연')).toBeTruthy();
    });

    it('회귀 fixture — initial 90s에서 폴 결과가 90s 그대로면 칩 미노출 (정상 진행)', () => {
      const train = makeTrain({ trainCode: 'T-SAME', arrivalSeconds: 90 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={90}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('회귀 fixture — initial 90s에서 추가 1분(60s) 지연 = diff 60s < 180 임계치 → 칩 미노출', () => {
      // "1분 30초 → 그대로 1분 30초로 안 줄고 1분 더 지연" 시나리오 시작점.
      const train = makeTrain({ trainCode: 'T-1MIN', arrivalSeconds: 150 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={90}
        />,
      );
      // 60s 지연은 임계치 미만 → 칩 미노출. 누적이 임계치를 넘으면 칩 노출.
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('initialEtaSeconds 미전달 → 칩 미노출 (lock 없는 상태에서 안전)', () => {
      const train = makeTrain({ trainCode: 'T-NOLOCK', arrivalSeconds: 600 });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });

    it('filtered arrivals 비어있으면 칩 미노출', () => {
      // 헤더 line 2 + train.line 7 → 필터 후 빈 list. 칩도 미노출.
      const train = makeTrain({ trainCode: 'T-WRONG', line: '7' });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          initialEtaSeconds={60}
        />,
      );
      expect(queryByTestId('boarding-train-delay-chip')).toBeNull();
    });
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

  it('#807 nextStationLabel 전달 시 종착 제거하고 "<next>방면"만 표시', () => {
    // 5호선 마천행 등 종착 분기 누락 회귀의 회귀 차단. 종착 표기는 UI에서 빠진다.
    const train = makeTrain({ trainCode: 'T-NEXT', destination: '석남행', line: '7' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList
        arrivals={[train]}
        line="7"
        onSelect={() => {}}
        nextStationLabel="중곡"
      />,
    );
    expect(getByTestId('boarding-train-meta-T-NEXT').props.children).toBe('중곡방면');
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
    // #855: fallback 라벨에 분 라벨 포함. arrivalSeconds 60/180/300 → 1/3/5분.
    expect(getByTestId('boarding-train-sequence-T-1ST').props.children).toBe('약 1정거장 전 (약 1분 후)');
    expect(getByTestId('boarding-train-sequence-T-2ND').props.children).toBe('약 2정거장 전 (약 3분 후)');
    expect(getByTestId('boarding-train-sequence-T-3RD').props.children).toBe('약 3정거장 전 (약 5분 후)');
  });

  it('#749 compact 모드: 헤더/trainCode 라인 생략, 단일 row "<next>방면" 라벨(#807)', () => {
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
    expect(getByTestId('boarding-train-meta-T-COMPACT').props.children).toBe('중곡방면');
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
    expect(getByTestId('boarding-train-sequence-T-CO-SEQ').props.children).toBe('약 1정거장 전 (약 3분 후)');
    expect(getByTestId('boarding-train-arrival-T-CO-SEQ')).toBeTruthy();
  });

  it('#649 compact + 빈 arrivals 도 동일 placeholder', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[]} line="7" onSelect={() => {}} compact />,
    );
    expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
    expect(getByText('도착 예정 열차가 없습니다.')).toBeTruthy();
  });

  // #807 라벨 통일 — 종착(마천행/방화행 등) 제거하고 "<next>방면"만 노출.
  // nextStationLabel 미전달 시에만 종착 fallback. 노선/종착 표기에 무관 동일 결과.
  describe('#807 종착 제거 · "<next>방면" 통일', () => {
    it.each<[string, string, LineNumber, string | null, string]>([
      ['방면 패턴 종착 + next → next만', '어린이대공원(세종대)방면', '7', '구의', '구의방면'],
      ['순환선 + nextStationLabel 없음 → 종착 fallback', '내선순환', '2', null, '내선순환'],
      ['일반 종착 + 다른 인접역 → next방면', '도봉산행', '7', '중곡', '중곡방면'],
      ['terminal=next 케이스도 dedup 없이 next방면', '도봉산행', '1', '도봉산', '도봉산방면'],
      // 5호선 회귀 가드 — 종착 분기 누락 차단의 회귀 자체 제거.
      ['5호선 마천행 → next방면', '마천행', '5', '중곡', '중곡방면'],
      ['5호선 방화행 → next방면', '방화행', '5', '광화문', '광화문방면'],
    ])('%s', (_, destination, line, nextStationLabel, expected) => {
      const train = makeTrain({ trainCode: 'T-807', destination, line });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line={line}
          onSelect={() => {}}
          nextStationLabel={nextStationLabel}
        />,
      );
      expect(getByTestId('boarding-train-meta-T-807').props.children).toBe(expected);
    });
  });

  describe('#790 거리 표기 — API arvlMsg2 실측치', () => {
    it('statusMessage "[4]번째 전역 (문정)" → "4번째 전"', () => {
      const train = makeTrain({ trainCode: 'T-DIST', statusMessage: '[4]번째 전역 (문정)' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-sequence-T-DIST').props.children).toBe('4번째 전');
    });

    it('statusMessage "전역 출발"(비매칭)이면 원본 그대로 표시', () => {
      const train = makeTrain({ trainCode: 'T-DEPARTED', statusMessage: '전역 출발' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-sequence-T-DEPARTED').props.children).toBe('전역 출발');
    });

    it('#855 statusMessage 빈 문자열(mock/schedule)이면 "약 N정거장 전 (약 M분 후)" fallback', () => {
      const trains = [
        makeTrain({ trainCode: 'T-MOCK-1', statusMessage: '' }),
        makeTrain({ trainCode: 'T-MOCK-2', statusMessage: '' }),
      ];
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={trains} line="2" onSelect={() => {}} />,
      );
      // arrivalSeconds=180 default → 3분.
      expect(getByTestId('boarding-train-sequence-T-MOCK-1').props.children).toBe(
        '약 1정거장 전 (약 3분 후)',
      );
      expect(getByTestId('boarding-train-sequence-T-MOCK-2').props.children).toBe(
        '약 2정거장 전 (약 3분 후)',
      );
    });

    it('#855 statusMessage 빈 + arrivalSeconds=0 이면 분 라벨 생략 ("약 N정거장 전"만)', () => {
      const train = makeTrain({ trainCode: 'T-MOCK-0', statusMessage: '', arrivalSeconds: 0 });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getByTestId('boarding-train-sequence-T-MOCK-0').props.children).toBe('약 1정거장 전');
    });
  });

  describe('#805 도착 임박 상태에서도 시간 라벨 유지', () => {
    // arvlCd=0(진입)/1(도착)/2(출발)/3(전역 출발) 등 임박 상태에서 statusMessage가 시간 텍스트를
    // 대체하더라도 BoardingTrainList의 도착 예정 HH:mm 라벨은 별도 라인으로 항상 노출되어야 한다.
    it.each<[string, Partial<ArrivalInfo>]>([
      ['arrivalSeconds=0 + statusMessage 비어있음', { arrivalSeconds: 0, statusMessage: '' }],
      ['arrivalSeconds=0 + "곧 도착"', { arrivalSeconds: 0, statusMessage: '곧 도착' }],
      ['arrivalSeconds=1 + "전역 출발"', { arrivalSeconds: 1, statusMessage: '전역 출발' }],
      ['arrivalSeconds=30 + "당역 도착"', { arrivalSeconds: 30, statusMessage: '당역 도착' }],
    ])('%s — arrival 시간 라벨이 보임', (_, overrides) => {
      const base = new Date(2026, 0, 1, 9, 0).getTime();
      const train = makeTrain({ trainCode: 'T-805', receivedAtMs: base, ...overrides });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      const arrival = getByTestId('boarding-train-arrival-T-805');
      // 도착 예정 텍스트는 항상 "HH:mm 도착 예정" 형태로 렌더.
      expect(arrival.props.children).toMatch(/\d{2}:\d{2} 도착 예정$/);
    });

    it('sequence 라인과 arrival 라인은 별도 View — 시간 라벨이 같은 줄에서 가려지지 않음', () => {
      const train = makeTrain({ trainCode: 'T-LINES', statusMessage: '전역 출발' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      const sequence = getByTestId('boarding-train-sequence-T-LINES');
      const arrival = getByTestId('boarding-train-arrival-T-LINES');
      // 두 element가 동일 parent(같은 row) 안에 있되 서로 다른 View 안에 있어야 한다.
      expect(sequence.parent).not.toBe(arrival.parent);
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
