import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EditorialTimeline, mix, hex } from '../EditorialTimeline';
import { MOCK_STOPS } from '../../testUtils/fixtures';
import type { Stop } from '../../utils/journeyAdapter';
import { useAppStore } from '../../store/useAppStore';

// 결정적 빠른하차 픽스처 — quickExit 라벨/모드 분기 검증용.
// 3호선 경복궁(id 3-019)에만 상행 stairs/엘리베이터 엔트리 등록.
jest.mock('../../data/quickExit.json', () => ({
  '3-019': {
    stairs: [{ doorNumber: '3-2', direction: 'up' }],
    elevator: [{ doorNumber: '5-1', direction: 'up' }],
  },
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

  it('arrivalContext 없는 stop(filled)에는 라벨이 안 뜬다', () => {
    render(<EditorialTimeline stops={[{ station: '교대', line: '3', mark: 'filled' }]} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
  });

  it('비단조 노선(2호선)이면 quickExit 데이터가 있어도 라벨 미표시', () => {
    const stops: Stop[] = [
      { station: '강남', line: '2', mark: 'filled' },
      {
        station: '경복궁',
        line: '2',
        stopsFromPrev: '5정거장',
        mark: 'dest',
        note: '도착',
        arrivalContext: { line: '2', fromName: '강남', toName: '경복궁' },
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
  });

  it('단조 노선이지만 도착역에 데이터가 없으면 라벨 미표시', () => {
    const stops: Stop[] = [
      { station: '경복궁', line: '3', mark: 'filled' },
      {
        station: '오금',
        line: '3',
        stopsFromPrev: '3정거장',
        mark: 'dest',
        note: '도착',
        arrivalContext: { line: '3', fromName: '경복궁', toName: '오금' },
      },
    ];
    render(<EditorialTimeline stops={stops} />);
    expect(screen.queryByText(/번 문/)).toBeNull();
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
