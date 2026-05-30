import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EditorialTimeline, mix, hex } from '../EditorialTimeline';
import { MOCK_STOPS } from '../../testUtils/fixtures';
import type { Stop } from '../../utils/journeyAdapter';
import type { LineNumber } from '../../types/station';
import { useAppStore } from '../../store/useAppStore';

// 결정적 빠른하차 픽스처 — quickExit 라벨/모드 분기 검증용.
// 3호선 경복궁(id 3-019)에만 상행 stairs/엘리베이터 엔트리 등록.
jest.mock('../../data/quickExit.json', () => ({
  '3-019': {
    stairs: [{ doorNumber: '3-2', direction: 'up' }],
    elevator: [{ doorNumber: '5-1', direction: 'up' }],
  },
}));

// 빠른 환승 도어 — 군자(5↔7) 단순 fixture.
jest.mock('../../data/transferExit.json', () => ({
  군자: [
    { fromLine: '5', toLine: '7', doorNumber: '1-1' },
    { fromLine: '7', toLine: '5', doorNumber: '5-1' },
  ],
}));

describe('EditorialTimeline', () => {
  it('should render all stops', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.threeStops} />);
    expect(screen.getByText('효창공원앞')).toBeTruthy();
    expect(screen.getByText('공덕')).toBeTruthy();
    expect(screen.getByText('여의나루')).toBeTruthy();
  });

  it('should render filled dot for first stop', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.twoStops} />);
    expect(screen.getByTestId('filled-dot')).toBeTruthy();
  });

  it('should render transfer dot for transfer stop', () => {
    const stops: Stop[] = [
      { station: '서울역', line: '1', mark: 'filled' },
      { station: '시청', line: '2', stopsFromPrev: '1정거장', mark: 'transfer', note: '환승' },
      { station: '을지로입구', line: '2', stopsFromPrev: '1정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByTestId('transfer-dot')).toBeTruthy();
  });

  it('should render dest dot for destination stop', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.twoStops} />);
    expect(screen.getByTestId('dest-dot')).toBeTruthy();
  });

  it('should render note text', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.twoStops} />);
    expect(screen.getByText('도착')).toBeTruthy();
  });

  it('should render stopsFromPrev text', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.twoStops} />);
    expect(screen.getByText('1정거장')).toBeTruthy();
  });

  it('should render line name for known lines', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.twoStops} />);
    expect(screen.getAllByText('2호선').length).toBeGreaterThan(0);
  });

  it('should handle null line gracefully', () => {
    const stops: Stop[] = [
      { station: '출발역', line: null, mark: 'filled' },
      { station: '종착역', line: null, stopsFromPrev: '5정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByText('출발역')).toBeTruthy();
    expect(screen.getByText('종착역')).toBeTruthy();
  });

  it('should handle special line names (airport)', () => {
    const stops: Stop[] = [
      { station: '서울역', line: 'airport', mark: 'filled' },
      { station: '인천공항', line: 'airport', stopsFromPrev: '5정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getAllByText('공항철도').length).toBeGreaterThan(0);
  });

  it('should fallback to LINE label and accent color for unknown line', () => {
    const stops: Stop[] = [
      { station: '출발역', line: 'unknown', mark: 'filled' },
      { station: '종착역', line: 'unknown', stopsFromPrev: '3정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getAllByText('LINE unknown').length).toBeGreaterThan(0);
  });

  it('should render empty for no stops', () => {
    const { toJSON } = render(<EditorialTimeline stops={[]} />);
    expect(toJSON()).toBeTruthy();
  });

  it('#649 renderHopSlot — 각 hop 직후 slot 노드가 렌더된다 (non-null 반환에만)', () => {
    const { Text } = require('react-native');
    render(
      <EditorialTimeline
        stops={MOCK_STOPS.threeStops}
        renderHopSlot={(stop, i) =>
          i === 0 ? <Text testID="slot-content-0">slot0</Text> : null
        }
      />,
    );
    expect(screen.getByTestId('timeline-hop-slot-0')).toBeTruthy();
    expect(screen.getByTestId('slot-content-0')).toBeTruthy();
    // i=1,2는 null 반환 — slot 컨테이너 자체도 없음
    expect(screen.queryByTestId('timeline-hop-slot-1')).toBeNull();
    expect(screen.queryByTestId('timeline-hop-slot-2')).toBeNull();
  });

  it('#649 renderHopSlot 미전달이면 slot 컨테이너 없음 (기존 호출자 영향 0)', () => {
    render(<EditorialTimeline stops={MOCK_STOPS.threeStops} />);
    expect(screen.queryByTestId('timeline-hop-slot-0')).toBeNull();
  });
});

describe('EditorialTimeline quickExit door label', () => {
  beforeEach(() => {
    useAppStore.setState({ accessibilityMode: false });
  });

  // 단조노선(3호선) + 경복궁 데이터 보유 + 상행 매칭(교대→경복궁) → stairs 우선으로 3-2 표시.
  const stopsWithQuickExit: Stop[] = [
    { station: '교대', line: '3', mark: 'filled' },
    {
      station: '경복궁',
      line: '3',
      stopsFromPrev: '5정거장',
      mark: 'dest',
      note: '도착',
      arrivalContext: { line: '3', fromName: '교대', toName: '경복궁' },
    },
  ];

  it('단조 노선 + quickExit 데이터 있으면 stairs 우선(기본 모드)으로 문번호 라벨이 뜬다', () => {
    render(<EditorialTimeline stops={stopsWithQuickExit} />);
    expect(screen.getByText('3-2번 문')).toBeTruthy();
  });

  it('accessibilityMode ON 이면 elevator 우선으로 다른 문번호가 뜬다', () => {
    useAppStore.setState({ accessibilityMode: true });
    render(<EditorialTimeline stops={stopsWithQuickExit} />);
    expect(screen.getByText('5-1번 문')).toBeTruthy();
    expect(screen.queryByText('3-2번 문')).toBeNull();
  });

  it('arrivalContext 없는 stop(filled) 단독이면 라벨이 안 뜬다', () => {
    render(<EditorialTimeline stops={[{ station: '교대', line: '3', mark: 'filled' }]} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
  });

  it('#635 출발역(filled) + 다음 stop 빠른 도어 → 출발역에도 "탑승 X-Y번 문" 라벨', () => {
    // stopsWithQuickExit: 교대(filled, 3호선) → 경복궁(dest, 3호선). 다음 stop 도어 3-2.
    render(<EditorialTimeline stops={stopsWithQuickExit} />);
    expect(screen.getByText('탑승 3-2번 문')).toBeTruthy();
    expect(screen.getByTestId('boarding-door-0')).toBeTruthy();
    // 도착 stop은 원래 "3-2번 문"(탑승 prefix 없음) 그대로 유지
    expect(screen.getByTestId('quick-exit-door-1')).toBeTruthy();
  });

  it('#635 출발역만 있고 다음 stop 없으면 boarding-door 라벨 안 뜬다', () => {
    render(<EditorialTimeline stops={[{ station: '교대', line: '3', mark: 'filled' }]} />);
    expect(screen.queryByTestId(/^boarding-door-/)).toBeNull();
  });

  it('#635 transfer stop인데 transferTarget 누락이면 quickExit fallback으로 도어 결정', () => {
    // 군자는 transferExit fixture에 5→7=1-1 있지만 transferTarget 미전달 → fallback 경로.
    // 군자는 quickExit fixture에 없으므로 fallback도 null → 라벨 미표시.
    const stops: Stop[] = [
      { station: '방화', line: '5', mark: 'filled' },
      {
        station: '군자',
        line: '7',
        stopsFromPrev: '20정거장',
        mark: 'transfer',
        note: '환승',
        arrivalContext: { line: '5', fromName: '방화', toName: '군자' },
        // transferTarget 의도적 누락
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
  });

  it('#635 expanded 모드 — origin과 첫 hop 사이에 intermediate stops 있어도 boarding 라벨 살아남음', () => {
    // expanded 시 journeyAdapter가 intermediate stops 삽입. 인접 [i+1]은 intermediate (arrivalContext 없음).
    // 코드는 arrivalContext 있는 첫 후속 stop을 찾아야 함.
    const stops: Stop[] = [
      { station: '교대', line: '3', mark: 'filled' },
      { station: '남부터미널', line: '3', mark: 'intermediate' },
      { station: '양재', line: '3', mark: 'intermediate' },
      {
        station: '경복궁',
        line: '3',
        stopsFromPrev: '5정거장',
        mark: 'dest',
        note: '도착',
        arrivalContext: { line: '3', fromName: '교대', toName: '경복궁' },
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByText('탑승 3-2번 문')).toBeTruthy();
    expect(screen.getByTestId('boarding-door-0')).toBeTruthy();
  });

  // 라벨 미표시 케이스 — fromName→toName 단일 segment fixture.
  // 각 케이스의 의도는 setup이 아니라 it 설명에 둔다.
  function makeDestOnlyStops(line: LineNumber, fromName: string, toName: string): Stop[] {
    return [
      { station: fromName, line, mark: 'filled' },
      {
        station: toName,
        line,
        stopsFromPrev: '3정거장',
        mark: 'dest',
        note: '도착',
        arrivalContext: { line, fromName, toName },
      },
    ];
  }

  it.each<[string, LineNumber, string, string]>([
    ['비단조 노선(2호선) — 데이터 있어도 라벨 미표시', '2', '강남', '경복궁'],
    ['단조 노선 + 도착역 데이터 없음 — 라벨 미표시', '3', '경복궁', '오금'],
  ])('%s', (_label, line, from, to) => {
    render(<EditorialTimeline stops={makeDestOnlyStops(line, from, to)} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
  });

  it('환승 stop이고 transferExit 매칭이 있으면 transferDoor가 quickExit보다 우선 표시', () => {
    // transferExit fixture는 군자 5→7=1-1. quickExit fixture엔 군자 없음.
    const stops: Stop[] = [
      { station: '방화', line: '5', mark: 'filled' },
      {
        station: '군자',
        line: '7',
        stopsFromPrev: '20정거장',
        mark: 'transfer',
        note: '환승',
        arrivalContext: { line: '5', fromName: '방화', toName: '군자' },
        transferTarget: { toLine: '7' },
      },
      {
        station: '도봉산',
        line: '7',
        stopsFromPrev: '15정거장',
        mark: 'dest',
        note: '도착',
        arrivalContext: { line: '7', fromName: '군자', toName: '도봉산' },
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByText('1-1번 문')).toBeTruthy();
  });

  it('환승 stop이지만 transferExit 매칭이 없으면 quickExit fallback', () => {
    // 3호선 경복궁 quickExit 데이터 있음, transferExit엔 경복궁 없음 → fallback 3-2.
    const stops: Stop[] = [
      { station: '교대', line: '3', mark: 'filled' },
      {
        station: '경복궁',
        line: 'unknown',
        stopsFromPrev: '5정거장',
        mark: 'transfer',
        note: '환승',
        arrivalContext: { line: '3', fromName: '교대', toName: '경복궁' },
        transferTarget: { toLine: 'sinbundang' },
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByText('3-2번 문')).toBeTruthy();
  });
});

describe('intermediate stop 렌더링', () => {
  it('intermediate mark는 intermediate-dot을 렌더링한다', () => {
    const stops: Stop[] = [
      { station: '강남', line: '2', mark: 'filled' },
      { station: '교대', line: '2', mark: 'intermediate' },
      { station: '서초', line: '2', stopsFromPrev: '2정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.getByTestId('intermediate-dot')).toBeTruthy();
    expect(screen.getByText('교대')).toBeTruthy();
  });

  it('intermediate stop은 LineBadge를 렌더링하지 않는다', () => {
    const stops: Stop[] = [
      { station: '강남', line: '2', mark: 'filled' },
      { station: '교대', line: '2', mark: 'intermediate' },
      { station: '서초', line: '2', stopsFromPrev: '2정거장', mark: 'dest', note: '도착' },
    ];
    render(<EditorialTimeline stops={stops} />);
    // 2호선 라벨은 출발/도착 stop 2개에서만 노출 (intermediate에서는 미노출)
    expect(screen.getAllByText('2호선').length).toBe(2);
  });
});

describe('mix', () => {
  it('should blend two colors at 50%', () => {
    expect(mix('#FF0000', '#0000FF', 0.5)).toBe('rgb(128,0,128)');
  });

  it('should return first color at weight 0', () => {
    expect(mix('#FF0000', '#0000FF', 0)).toBe('rgb(255,0,0)');
  });

  it('should return second color at weight 1', () => {
    expect(mix('#FF0000', '#0000FF', 1)).toBe('rgb(0,0,255)');
  });
});

describe('hex', () => {
  it('should parse hex color to RGB tuple', () => {
    expect(hex('#FF0000')).toEqual([255, 0, 0]);
    expect(hex('#00FF00')).toEqual([0, 255, 0]);
    expect(hex('#0000FF')).toEqual([0, 0, 255]);
  });

  it('should fallback to [0,0,0] for non-hex formats', () => {
    expect(hex('rgba(26,24,20,0.08)')).toEqual([0, 0, 0]);
    expect(hex('rgb(255,0,0)')).toEqual([0, 0, 0]);
    expect(hex('FF8800')).toEqual([0, 0, 0]);
    expect(hex('#FFF')).toEqual([0, 0, 0]);
  });
});
