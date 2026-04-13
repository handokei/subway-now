import React from 'react';
import { render } from '@testing-library/react-native';
import { JourneyTimeline } from '../JourneyTimeline';
import type { JourneyDisplay } from '../../utils/stationRoute';

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
  it('직통 여정을 렌더링한다', () => {
    const { getByText } = render(<JourneyTimeline journey={directJourney} />);
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('삼성')).toBeTruthy();
    expect(getByText('2호선')).toBeTruthy();
    expect(getByText('2정거장')).toBeTruthy();
  });

  it('환승 여정을 렌더링한다', () => {
    const { getByText, getAllByText } = render(
      <JourneyTimeline journey={transferJourney} />,
    );
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('교대')).toBeTruthy();
    expect(getByText('경복궁')).toBeTruthy();
    expect(getByText('2호선')).toBeTruthy();
    expect(getByText('3호선')).toBeTruthy();
    expect(getByText('1정거장')).toBeTruthy();
    expect(getByText('5정거장')).toBeTruthy();
  });

  it('ETA를 표시한다', () => {
    const { getByText } = render(
      <JourneyTimeline journey={directJourney} etaMinutes={15} />,
    );
    expect(getByText('약 15분 소요')).toBeTruthy();
  });

  it('etaMinutes가 null이면 ETA를 표시하지 않는다', () => {
    const { queryByText } = render(
      <JourneyTimeline journey={directJourney} etaMinutes={null} />,
    );
    expect(queryByText(/소요/)).toBeNull();
  });

  it('etaMinutes가 undefined이면 ETA를 표시하지 않는다', () => {
    const { queryByText } = render(
      <JourneyTimeline journey={directJourney} />,
    );
    expect(queryByText(/소요/)).toBeNull();
  });

  it('알 수 없는 노선이면 line 값을 그대로 표시한다', () => {
    const unknownLineJourney: JourneyDisplay = {
      segments: [
        {
          line: 'unknown',
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
