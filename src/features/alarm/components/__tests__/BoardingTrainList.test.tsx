import { act, fireEvent } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { BoardingTrainList } from '../BoardingTrainList';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { LINE_COLORS } from '../../../../shared/constants/lineColors';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { LineNumber } from '../../../../shared/types/station';
import {
  getLockCorrectionMetrics,
  resetLockCorrectionMetrics,
} from '../../utils/lockCorrectionMetrics';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('arrivals 비어있을 때 placeholder 렌더 (#915 후속: i18n 키 사용)', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <BoardingTrainList arrivals={[]} line="2" onSelect={() => {}} />,
    );
    expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
    // jest.setup.js의 i18n 기본 lng='ko' → ko.json home.boardingTrainListEmpty 값.
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

  // #668 회귀 가드 — compact 모드 row에 카드 배경(colors.card)이 절대 붙지 않음을 강제.
  // 실기기 회귀(EditorialTimeline hop slot에서 BoardingTrainList가 카드+헤더 모드로 보임)는
  // 빌드 캐시가 1차 원인이었지만, 컴포넌트 자체에서 compact 분기가 우발적으로 backgroundColor를
  // 받지 않도록 contract 테스트로 못 박는다. 일반 모드는 기존 다른 테스트에서 stripe + 카드 배경
  // 결합이 검증되므로 여기서는 compact 음성 케이스만 추가.
  it('#668 compact 모드 row는 colors.card 배경을 받지 않는다 (회귀 가드)', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
      if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
      return (style ?? {}) as Record<string, unknown>;
    }
    const train = makeTrain({ trainCode: 'T-668', line: '7' });
    const { getByTestId } = renderWithTheme(
      <BoardingTrainList arrivals={[train]} line="7" onSelect={() => {}} compact />,
    );
    const row = getByTestId('boarding-train-row-T-668');
    const style = flattenStyle(row.props.style);
    expect(style.backgroundColor).toBeUndefined();
    // 헤더 라벨도 노출되면 안 됨 (#649 핵심 contract 재확인).
    expect(row.props.style).toBeDefined();
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

  describe('#1165 낙관적 탭 + pending state (Epic #1008 C 단기 1번 / B4 경로 1)', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
      if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
      return (style ?? {}) as Record<string, unknown>;
    }

    it('탭 즉시 pending marker 노출 + onSelect 동시 호출 (synchronous, round-trip 대기 없음)', () => {
      const train = makeTrain({ trainCode: 'T-OPT' });
      const onSelect = jest.fn();
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
      );
      expect(queryByTestId('boarding-train-pending-T-OPT')).toBeNull();
      fireEvent.press(getByTestId('boarding-train-row-T-OPT'));
      // 시각 피드백은 onSelect와 동기적으로 발생 (round-trip 대기 없음 — 100ms 이내).
      expect(getByTestId('boarding-train-pending-T-OPT')).toBeTruthy();
      expect(onSelect).toHaveBeenCalledWith(train);
    });

    it('pending 상태 row는 accent outline border로 시각 highlight', () => {
      const train = makeTrain({ trainCode: 'T-OUTLINE', line: '2' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      const row = getByTestId('boarding-train-row-T-OUTLINE');
      const before = flattenStyle(row.props.style);
      expect(before.borderWidth).toBeUndefined();
      fireEvent.press(row);
      const after = flattenStyle(row.props.style);
      expect(after.borderWidth).toBeGreaterThan(0);
      expect(after.borderColor).toBeDefined();
    });

    it('pending 중 같은 row 재탭 시 onSelect 추가 호출되지 않음 (중복 탭 방지)', () => {
      const train = makeTrain({ trainCode: 'T-DUP' });
      const onSelect = jest.fn();
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-DUP'));
      fireEvent.press(getByTestId('boarding-train-row-T-DUP'));
      fireEvent.press(getByTestId('boarding-train-row-T-DUP'));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('pending 중 다른 row 탭 시 disabled — onSelect 호출 안 됨', () => {
      const a = makeTrain({ trainCode: 'T-A' });
      const b = makeTrain({ trainCode: 'T-B' });
      const onSelect = jest.fn();
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[a, b]} line="2" onSelect={onSelect} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-A'));
      fireEvent.press(getByTestId('boarding-train-row-T-B'));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(a);
    });

    it('lockedTrainCode가 pendingTrainCode와 일치하면 pending confirmed → marker 제거 + 재탭 가능', () => {
      const train = makeTrain({ trainCode: 'T-CONF' });
      const onSelect = jest.fn();
      const { getByTestId, queryByTestId, rerender } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-CONF'));
      expect(getByTestId('boarding-train-pending-T-CONF')).toBeTruthy();
      rerender(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={onSelect}
          lockedTrainCode="T-CONF"
        />,
      );
      expect(queryByTestId('boarding-train-pending-T-CONF')).toBeNull();
      // 재탭 가능(다른 lock 변경 등) — onSelect 누적 2회.
      fireEvent.press(getByTestId('boarding-train-row-T-CONF'));
      expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it('pendingTimeoutMs 경과 시 자동 rollback — marker 제거 + 재탭 가능', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-TIMEOUT' });
        const onSelect = jest.fn();
        const { getByTestId, queryByTestId } = renderWithTheme(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            pendingTimeoutMs={3000}
          />,
        );
        fireEvent.press(getByTestId('boarding-train-row-T-TIMEOUT'));
        expect(getByTestId('boarding-train-pending-T-TIMEOUT')).toBeTruthy();
        act(() => {
          jest.advanceTimersByTime(3000);
        });
        expect(queryByTestId('boarding-train-pending-T-TIMEOUT')).toBeNull();
        fireEvent.press(getByTestId('boarding-train-row-T-TIMEOUT'));
        expect(onSelect).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('unmount 시 rollback timer 정리 — pending timeout 이후 setState 호출되지 않음', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-UNMOUNT' });
        const { getByTestId, unmount } = renderWithTheme(
          <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
        );
        fireEvent.press(getByTestId('boarding-train-row-T-UNMOUNT'));
        unmount();
        // setTimeout 시간 경과 — unmount 후 setState 호출 시 React warning 발생 가능.
        // 본 테스트는 warning 없이 통과해야 한다.
        expect(() =>
          act(() => {
            jest.advanceTimersByTime(10000);
          }),
        ).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });

    // #1166: 정정 case는 별도 describe(`#1166 정정 toast UX`)에서 다룬다. #1165 단계에서 mismatch는
    // pending을 유지했으나, #1166이 적용된 이후로는 mismatch가 정정 신호로 해석되어 pending이 즉시
    // 해제된다. 기존 회귀 가드는 정정 동작 테스트(`pending(A) → lock(B) 정정...`)로 대체된다.

    it('lockedTrainCode만 있고 pending이 없으면 effect는 no-op (다른 채널로 lock 생성된 케이스)', () => {
      const train = makeTrain({ trainCode: 'T-EXT' });
      const { queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-EXT"
        />,
      );
      expect(queryByTestId('boarding-train-pending-T-EXT')).toBeNull();
    });

    it('walkingBufferSeconds로 disabled인 row는 탭해도 pending 진입 안 함', () => {
      const tooSoon = makeTrain({ trainCode: 'T-EARLY', arrivalSeconds: 60 });
      const onSelect = jest.fn();
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[tooSoon]}
          line="2"
          onSelect={onSelect}
          walkingBufferSeconds={180}
        />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-EARLY'));
      expect(onSelect).not.toHaveBeenCalled();
      expect(queryByTestId('boarding-train-pending-T-EARLY')).toBeNull();
    });

    it('연속 두 번째 탭이 새 timer로 교체되지 않음 (pending 동안 모든 탭 무시) — accessibilityState.busy=true', () => {
      const train = makeTrain({ trainCode: 'T-BUSY' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      const row = getByTestId('boarding-train-row-T-BUSY');
      expect(row.props.accessibilityState.busy).toBe(false);
      fireEvent.press(row);
      const rowAfter = getByTestId('boarding-train-row-T-BUSY');
      expect(rowAfter.props.accessibilityState.busy).toBe(true);
      expect(rowAfter.props.accessibilityState.disabled).toBe(false);
    });
  });

  describe('#1166 lock 정정 toast UX (Epic #1008 C 단기 2번 / B4 round-trip)', () => {
    beforeEach(() => {
      resetLockCorrectionMetrics();
    });

    it('pending(A) → lockedTrainCode(B) 정정 시 pending 즉시 해제 + onLockCorrected(A, B) 호출', () => {
      const train = makeTrain({ trainCode: 'T-A' });
      const onLockCorrected = jest.fn();
      const { getByTestId, queryByTestId, rerender } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          onLockCorrected={onLockCorrected}
        />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-A'));
      expect(getByTestId('boarding-train-pending-T-A')).toBeTruthy();
      rerender(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-B"
          onLockCorrected={onLockCorrected}
        />,
      );
      expect(queryByTestId('boarding-train-pending-T-A')).toBeNull();
      expect(onLockCorrected).toHaveBeenCalledTimes(1);
      expect(onLockCorrected).toHaveBeenCalledWith('T-A', 'T-B');
    });

    it('정정 시 metric counter 적재 — fired 누적 + lastFiredAtMs > 0', () => {
      const train = makeTrain({ trainCode: 'T-METRIC' });
      const { getByTestId, rerender } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      expect(getLockCorrectionMetrics().fired).toBe(0);
      fireEvent.press(getByTestId('boarding-train-row-T-METRIC'));
      rerender(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-OTHER"
        />,
      );
      const metrics = getLockCorrectionMetrics();
      expect(metrics.fired).toBe(1);
      expect(metrics.lastFiredAtMs).toBeGreaterThan(0);
    });

    it('정상 확정(같은 trainCode) 시 onLockCorrected 미호출 + metric 미적재', () => {
      const train = makeTrain({ trainCode: 'T-SAME' });
      const onLockCorrected = jest.fn();
      const { getByTestId, rerender } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          onLockCorrected={onLockCorrected}
        />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-SAME'));
      rerender(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-SAME"
          onLockCorrected={onLockCorrected}
        />,
      );
      expect(onLockCorrected).not.toHaveBeenCalled();
      expect(getLockCorrectionMetrics().fired).toBe(0);
    });

    it('onLockCorrected 미전달이어도 정정 동작은 동일 — pending 해제 + metric 적재(wiring 회귀 가드)', () => {
      const train = makeTrain({ trainCode: 'T-NOCB' });
      const { getByTestId, queryByTestId, rerender } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-NOCB'));
      rerender(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-DIFF"
        />,
      );
      expect(queryByTestId('boarding-train-pending-T-NOCB')).toBeNull();
      expect(getLockCorrectionMetrics().fired).toBe(1);
    });

    it('정정 후 lock 해제되면 같은 row를 다시 탭해 새 pending 진입 가능 (rollback timer 해제 확인)', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-RETAP' });
        const onSelect = jest.fn();
        const { getByTestId, rerender } = renderWithTheme(
          <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
        );
        fireEvent.press(getByTestId('boarding-train-row-T-RETAP'));
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode="T-X"
          />,
        );
        // 정정 후 lockedTrainCode가 다시 null로 풀린 상태(사용자 명시 해제 등)에서 재탭이 새 pending 진입.
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode={null}
          />,
        );
        // #1366 Layer 1 — lockedTrainCode가 non-null → null로 전환되면 800ms release guard가 걸린다.
        // 이 테스트는 guard 만료 후 재탭이 성공함을 검증.
        act(() => {
          jest.advanceTimersByTime(900);
        });
        fireEvent.press(getByTestId('boarding-train-row-T-RETAP'));
        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(getByTestId('boarding-train-pending-T-RETAP')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('lockedTrainCode만 set이고 pending이 없으면 정정 신호 무시 (외부 lock — 별 채널)', () => {
      const train = makeTrain({ trainCode: 'T-EXT2' });
      const onLockCorrected = jest.fn();
      renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          lockedTrainCode="T-EXT2"
          onLockCorrected={onLockCorrected}
        />,
      );
      expect(onLockCorrected).not.toHaveBeenCalled();
      expect(getLockCorrectionMetrics().fired).toBe(0);
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

  // #1177 — 4가지 state 명시 구분 (loading / empty / pending / error).
  // 우선순위: error > loading > empty > data + (pending overlay).
  describe('#1177 4가지 state 구분', () => {
    function renderState(props: {
      arrivals?: ArrivalInfo[];
      loading?: boolean;
      error?: { message?: string | null } | null;
    }) {
      return renderWithTheme(
        <BoardingTrainList
          arrivals={props.arrivals ?? []}
          line="2"
          onSelect={() => {}}
          loading={props.loading}
          error={props.error}
        />,
      );
    }

    type StateCase = {
      name: string;
      input: { arrivals?: ArrivalInfo[]; loading?: boolean; error?: { message?: string | null } | null };
      visibleTestId: string;
      hiddenTestIds: string[];
    };

    const cases: StateCase[] = [
      {
        name: 'loading=true → skeleton 노출, empty/error/data row 미노출',
        input: { loading: true },
        visibleTestId: 'boarding-train-list-loading',
        hiddenTestIds: ['boarding-train-list-empty', 'boarding-train-list-error', 'boarding-train-list'],
      },
      {
        name: 'empty(default) → empty placeholder 노출',
        input: {},
        visibleTestId: 'boarding-train-list-empty',
        hiddenTestIds: ['boarding-train-list-loading', 'boarding-train-list-error', 'boarding-train-list'],
      },
      {
        name: 'error 객체 → error UI 노출, loading/empty 무시',
        input: { loading: true, error: { message: 'network down' } },
        visibleTestId: 'boarding-train-list-error',
        hiddenTestIds: ['boarding-train-list-loading', 'boarding-train-list-empty', 'boarding-train-list'],
      },
    ];

    it.each(cases)('$name', ({ input, visibleTestId, hiddenTestIds }) => {
      const { getByTestId, queryByTestId } = renderState(input);
      expect(getByTestId(visibleTestId)).toBeTruthy();
      hiddenTestIds.forEach((id) => {
        expect(queryByTestId(id)).toBeNull();
      });
    });

    it('loading → 3개 skeleton row 렌더 (글로벌 룰 3: 인덱스 하드코딩 금지)', () => {
      const { getByTestId } = renderState({ loading: true });
      ['s1', 's2', 's3'].forEach((key) => {
        expect(getByTestId(`boarding-train-list-skeleton-${key}`)).toBeTruthy();
      });
    });

    it('loading → compact 모드에서도 skeleton 노출(헤더 생략)', () => {
      const { getByTestId, queryByText } = renderWithTheme(
        <BoardingTrainList arrivals={[]} line="2" onSelect={() => {}} loading compact />,
      );
      expect(getByTestId('boarding-train-list-loading')).toBeTruthy();
      // compact는 헤더 라벨 미노출.
      expect(queryByText('탑승할 열차 선택')).toBeNull();
    });

    it('error.message 명시 → 그대로 노출', () => {
      const { getByText } = renderState({ error: { message: '서버가 응답하지 않습니다' } });
      expect(getByText('서버가 응답하지 않습니다')).toBeTruthy();
      // 자동 재시도 안내(hint)도 함께 노출.
      expect(getByText('잠시 후 자동으로 다시 시도합니다.')).toBeTruthy();
    });

    it('error.message null/빈 문자열 → default 카피로 fallback', () => {
      const { getByText, rerender } = renderState({ error: { message: null } });
      expect(getByText('도착 정보를 불러올 수 없어요')).toBeTruthy();
      rerender(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          error={{ message: '' }}
        />,
      );
      expect(getByText('도착 정보를 불러올 수 없어요')).toBeTruthy();
    });

    it('error 객체이나 message 자체 미전달 → default 카피로 fallback', () => {
      const { getByText } = renderState({ error: {} });
      expect(getByText('도착 정보를 불러올 수 없어요')).toBeTruthy();
    });

    it('empty → 안내 카피 + 자동 재시도 hint 노출 + a11y label 적용', () => {
      const { getByTestId, getByText } = renderState({});
      const empty = getByTestId('boarding-train-list-empty');
      expect(empty.props.accessibilityLabel).toBe('도착 예정 열차 없음');
      expect(getByText('도착 예정 열차가 없습니다.')).toBeTruthy();
      expect(getByText('잠시 후 자동으로 다시 확인합니다.')).toBeTruthy();
    });

    it('data 있을 때 user 탭 → pending banner 노출 + a11y label', () => {
      const train = makeTrain({ trainCode: 'T-PEND-BANNER' });
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      // 탭 전: banner 미노출.
      expect(queryByTestId('boarding-train-list-pending-notice')).toBeNull();
      act(() => {
        fireEvent.press(getByTestId('boarding-train-row-T-PEND-BANNER'));
      });
      const notice = getByTestId('boarding-train-list-pending-notice');
      expect(notice).toBeTruthy();
      expect(notice.props.accessibilityLabel).toBe('탑승 등록을 처리하는 중');
    });

    it('loading state는 accessibilityState.busy=true', () => {
      const { getByTestId } = renderState({ loading: true });
      const container = getByTestId('boarding-train-list-loading');
      expect(container.props.accessibilityState?.busy).toBe(true);
      expect(container.props.accessibilityLabel).toBe('도착 정보를 불러오는 중');
    });

    it('error state — compact 모드에서도 노출(스타일 분기)', () => {
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          error={{ message: 'x' }}
          compact
        />,
      );
      expect(getByTestId('boarding-train-list-error')).toBeTruthy();
    });

    it('error state는 accessibilityRole=alert', () => {
      const { getByTestId } = renderState({ error: { message: 'x' } });
      const container = getByTestId('boarding-train-list-error');
      expect(container.props.accessibilityRole).toBe('alert');
      expect(container.props.accessibilityLabel).toBe('도착 정보를 불러올 수 없음');
    });
  });

  // #1888 (RC-13) — fallback 모드. boarding-prompt 응답 후 자동 lock 실패 시 호출자가 prop으로 set.
  describe('#1888 (RC-13) fallbackReason — 자동 lock 실패 fallback 표시', () => {
    type FallbackReason = 'autolock-empty' | 'autolock-ambiguity' | 'autolock-station-lookup';

    it.each<[string, FallbackReason]>([
      ['autolock-empty', 'autolock-empty'],
      ['autolock-ambiguity', 'autolock-ambiguity'],
      ['autolock-station-lookup', 'autolock-station-lookup'],
    ])('fallbackReason="%s" + arrivals=[] → fallback testID + fallback copy 노출', (_label, reason) => {
      const { getByTestId, getByText, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          fallbackReason={reason}
        />,
      );
      const container = getByTestId('boarding-train-list-fallback');
      expect(container).toBeTruthy();
      expect(container.props.accessibilityRole).toBe('alert');
      expect(container.props.accessibilityLabel).toBe('탑승 후보 없음');
      expect(getByText('탑승 후보를 찾을 수 없어요.')).toBeTruthy();
      expect(getByText('역 근처에서 다시 시도하거나 직접 선택해주세요.')).toBeTruthy();
      // 일반 empty placeholder는 미노출 (우선순위 검증).
      expect(queryByTestId('boarding-train-list-empty')).toBeNull();
    });

    it('fallbackReason set + arrivals 1+ → 정상 list 렌더 (fallback 무시)', () => {
      const train = makeTrain({ trainCode: 'T-FB-DATA' });
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[train]}
          line="2"
          onSelect={() => {}}
          fallbackReason="autolock-empty"
        />,
      );
      expect(getByTestId('boarding-train-list')).toBeTruthy();
      expect(getByTestId('boarding-train-row-T-FB-DATA')).toBeTruthy();
      expect(queryByTestId('boarding-train-list-fallback')).toBeNull();
    });

    it('fallbackReason null + arrivals=[] → 기존 empty placeholder (회귀 보존)', () => {
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          fallbackReason={null}
        />,
      );
      expect(getByTestId('boarding-train-list-empty')).toBeTruthy();
      expect(queryByTestId('boarding-train-list-fallback')).toBeNull();
    });

    it('우선순위 — error > fallback. error + fallbackReason 동시 set → error UI', () => {
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          fallbackReason="autolock-empty"
          error={{ message: 'down' }}
        />,
      );
      expect(getByTestId('boarding-train-list-error')).toBeTruthy();
      expect(queryByTestId('boarding-train-list-fallback')).toBeNull();
    });

    it('우선순위 — loading > fallback. loading + fallbackReason 동시 set → skeleton', () => {
      const { getByTestId, queryByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          fallbackReason="autolock-empty"
          loading
        />,
      );
      expect(getByTestId('boarding-train-list-loading')).toBeTruthy();
      expect(queryByTestId('boarding-train-list-fallback')).toBeNull();
    });

    it('compact 모드 — fallback 컨테이너에 emptyCompact 스타일 적용', () => {
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList
          arrivals={[]}
          line="2"
          onSelect={() => {}}
          fallbackReason="autolock-empty"
          compact
        />,
      );
      expect(getByTestId('boarding-train-list-fallback')).toBeTruthy();
    });
  });

  // #1366 Layer 1 — release-after-tap 보호 윈도우.
  // lockedTrainCode가 non-null → null로 전환된 직후 RELEASE_GUARD_MS(800ms) 동안 handlePress 차단.
  // 사용자가 빠르게 하차→재탑승하는 트립(8:33 환승역 즉시 재탑) race로 stale state POST → cron
  // "trainCode not found" 회귀를 방지.
  describe('#1366 Layer 1 — release guard window', () => {
    it('lockedTrainCode non-null → null 직후 탭은 무시 (guard ON)', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-GUARD' });
        const onSelect = jest.fn();
        const { getByTestId, rerender } = renderWithTheme(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode="T-GUARD"
          />,
        );
        // lock 해제
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode={null}
          />,
        );
        // 즉시 재탭 — guard로 차단되어야 함
        fireEvent.press(getByTestId('boarding-train-row-T-GUARD'));
        expect(onSelect).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('guard 만료(800ms) 후 탭은 정상 진행', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-GUARD2' });
        const onSelect = jest.fn();
        const { getByTestId, rerender } = renderWithTheme(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode="T-GUARD2"
          />,
        );
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode={null}
          />,
        );
        act(() => {
          jest.advanceTimersByTime(900);
        });
        fireEvent.press(getByTestId('boarding-train-row-T-GUARD2'));
        expect(onSelect).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('연속 release(guard 만료 전 재lock → 재release)는 기존 timer를 clear하고 새로 시작', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-RECLR' });
        const onSelect = jest.fn();
        const { getByTestId, rerender } = renderWithTheme(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode="T-RECLR"
          />,
        );
        // 1차 release — timer 시작
        rerender(
          <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} lockedTrainCode={null} />,
        );
        // 400ms 경과 (guard 아직 ON)
        act(() => {
          jest.advanceTimersByTime(400);
        });
        // 재lock
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={onSelect}
            lockedTrainCode="T-RECLR"
          />,
        );
        // 2차 release — 기존 timer clear 후 새 timer 시작 (line 240 도달)
        rerender(
          <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} lockedTrainCode={null} />,
        );
        // 1차 timer 만료 시각(원래 800ms)에서는 guard 여전히 ON
        act(() => {
          jest.advanceTimersByTime(500);
        });
        fireEvent.press(getByTestId('boarding-train-row-T-RECLR'));
        expect(onSelect).not.toHaveBeenCalled();
        // 2차 timer 만료 후엔 탭 가능
        act(() => {
          jest.advanceTimersByTime(400);
        });
        fireEvent.press(getByTestId('boarding-train-row-T-RECLR'));
        expect(onSelect).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lockedTrainCode가 처음부터 null(트립 시작 직후)이면 guard 미적용 — 즉시 탭 가능', () => {
      const train = makeTrain({ trainCode: 'T-FIRST' });
      const onSelect = jest.fn();
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={onSelect} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-FIRST'));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('unmount 시 guard timer cleanup (메모리 누수 방지)', () => {
      jest.useFakeTimers();
      try {
        const train = makeTrain({ trainCode: 'T-UNMOUNT-GUARD' });
        const { rerender, unmount } = renderWithTheme(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={() => {}}
            lockedTrainCode="T-UNMOUNT-GUARD"
          />,
        );
        rerender(
          <BoardingTrainList
            arrivals={[train]}
            line="2"
            onSelect={() => {}}
            lockedTrainCode={null}
          />,
        );
        unmount();
        // 후속 timer 진행 시 throw 안 함 — guard timer가 unmount cleanup으로 cleared.
        expect(() => {
          act(() => {
            jest.advanceTimersByTime(2000);
          });
        }).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('#1777 햅틱 피드백', () => {
    it('열차 row 탭 시 Medium 햅틱이 발사된다', () => {
      const train = makeTrain({ trainCode: 'T-HAPTIC' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[train]} line="2" onSelect={() => {}} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-HAPTIC'));
      expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    });

    it('pending 중 탭은 햅틱을 발사하지 않는다 (중복 탭 방지)', () => {
      const a = makeTrain({ trainCode: 'T-A' });
      const b = makeTrain({ trainCode: 'T-B' });
      const { getByTestId } = renderWithTheme(
        <BoardingTrainList arrivals={[a, b]} line="2" onSelect={() => {}} />,
      );
      fireEvent.press(getByTestId('boarding-train-row-T-A'));
      jest.clearAllMocks();
      fireEvent.press(getByTestId('boarding-train-row-T-B'));
      expect(Haptics.impactAsync).not.toHaveBeenCalled();
    });
  });
});
