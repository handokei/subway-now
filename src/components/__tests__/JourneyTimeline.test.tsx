import React from 'react';
import { render } from '@testing-library/react-native';
import { JourneyTimeline } from '../JourneyTimeline';
import type { JourneyDisplay } from '../../utils/stationRoute';
import type { LineNumber } from '../../types/station';
import { installLanguageRestoreHook, setLang } from '../../testUtils/i18nLanguageOverride';
import { useAppStore } from '../../store/useAppStore';

// 결정적 빠른하차 픽스처 — JourneyTimeline 표시 라벨 검증용.
// 3호선 경복궁(id 3-019)에만 상행 stairs/엘리베이터 엔트리 등록. 다른 노선/방향은 비어 있어
// quickExit 라벨이 표시되지 않는 fallback 경로도 함께 검증한다.
jest.mock('../../data/quickExit.json', () => ({
  '3-019': {
    stairs: [{ doorNumber: '3-2', direction: 'up' }],
    elevator: [{ doorNumber: '5-1', direction: 'up' }],
  },
}));

installLanguageRestoreHook();

const directJourney: JourneyDisplay = {
  segments: [
    {
      line: '2',
      lineColor: '#009D3E',
      fromName: '강남',
      toName: '삼성',
      stops: 2,
    },
  ],
  totalStops: 2,
};

const transferJourney: JourneyDisplay = {
  segments: [
    {
      line: '2',
      lineColor: '#009D3E',
      fromName: '강남',
      toName: '교대',
      stops: 1,
    },
    {
      line: '3',
      lineColor: '#EF7C1C',
      fromName: '교대',
      toName: '경복궁',
      stops: 5,
    },
  ],
  totalStops: 6,
};

describe('JourneyTimeline', () => {
  beforeEach(() => {
    useAppStore.setState({ accessibilityMode: false });
  });

  it('직통 여정을 렌더링한다 — 비단조 노선(2)이라 quickExit 라벨은 미표시', () => {
    const { getByText } = render(<JourneyTimeline journey={directJourney} />);
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('삼성')).toBeTruthy();
    expect(getByText('2호선')).toBeTruthy();
    expect(getByText('2정거장')).toBeTruthy();
  });

  it('환승 여정을 렌더링한다 — 3호선 경복궁 도착 구간에 quickExit 라벨 표시', () => {
    const { getByText } = render(
      <JourneyTimeline journey={transferJourney} />,
    );
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('교대')).toBeTruthy();
    expect(getByText('경복궁')).toBeTruthy();
    expect(getByText('2호선')).toBeTruthy();
    expect(getByText('3호선')).toBeTruthy();
    // 첫 세그먼트(2호선 강남→교대): 비단조 → quickExit 라벨 없음
    expect(getByText('1정거장')).toBeTruthy();
    // 두 번째 세그먼트(3호선 교대→경복궁): 단조, 상행, 경복궁 데이터 있음 → 3-2번 문
    expect(getByText('5정거장 · 3-2번 문')).toBeTruthy();
  });

  it('accessibilityMode=true 면 elevator 출입문이 우선 표시된다', () => {
    useAppStore.setState({ accessibilityMode: true });
    const { getByText } = render(<JourneyTimeline journey={transferJourney} />);
    expect(getByText('5정거장 · 5-1번 문')).toBeTruthy();
  });

  it('단조 노선 + stations 매칭은 됐지만 quickExit 데이터가 없으면 라벨이 안 붙는다', () => {
    const journey: JourneyDisplay = {
      segments: [
        // 3호선 단조이지만 도착역 오금은 quickExit mock에 등록 X → 라벨 미표시
        { line: '3', lineColor: '#EF7C1C', fromName: '경복궁', toName: '오금', stops: 3 },
      ],
      totalStops: 3,
    };
    const { getByText } = render(<JourneyTimeline journey={journey} />);
    expect(getByText('3정거장')).toBeTruthy();
  });

  it('출발역 dot에 노선 색상을 적용한다', () => {
    const { getByTestId } = render(<JourneyTimeline journey={directJourney} />);
    const startDot = getByTestId('start-dot');
    expect(startDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#009D3E' })]),
    );
  });

  it('도착역 dot에 노선 색상을 적용한다', () => {
    const { getByTestId } = render(<JourneyTimeline journey={directJourney} />);
    const endDot = getByTestId('end-dot');
    expect(endDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#009D3E' })]),
    );
  });

  it('환승 시 도착역 dot에 마지막 세그먼트 노선 색상을 적용한다', () => {
    const { getByTestId } = render(<JourneyTimeline journey={transferJourney} />);
    const endDot = getByTestId('end-dot');
    expect(endDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#EF7C1C' })]),
    );
  });

  it('영어 모드에서 환승 여정 역명이 nameEn으로 표시된다', () => {
    setLang('en');
    const { getByText } = render(<JourneyTimeline journey={transferJourney} />);
    expect(getByText('Gangnam')).toBeTruthy();
    expect(getByText('Seoul Nat`l Univ. of Education')).toBeTruthy();
    expect(getByText('Gyeongbokgung')).toBeTruthy();
    expect(getByText('1 stop')).toBeTruthy();
    expect(getByText('5 stops · Door 3-2')).toBeTruthy();
  });

  it('영어 모드 + stations에 없는 역명은 원본 그대로 표시한다', () => {
    setLang('en');
    const unknownStationJourney: JourneyDisplay = {
      segments: [
        {
          line: '2',
          lineColor: '#009D3E',
          fromName: '없는역A',
          toName: '없는역B',
          stops: 1,
        },
      ],
      totalStops: 1,
    };
    const { getByText } = render(<JourneyTimeline journey={unknownStationJourney} />);
    expect(getByText('없는역A')).toBeTruthy();
    expect(getByText('없는역B')).toBeTruthy();
  });

  it('알 수 없는 노선이면 line 값을 그대로 표시한다', () => {
    const unknownLineJourney: JourneyDisplay = {
      segments: [
        {
          line: 'unknown' as unknown as LineNumber,
          lineColor: '#999999',
          fromName: '역A',
          toName: '역B',
          stops: 1,
        },
      ],
      totalStops: 1,
    };
    const { getByText } = render(
      <JourneyTimeline journey={unknownLineJourney} />,
    );
    expect(getByText('unknown')).toBeTruthy();
  });
});
