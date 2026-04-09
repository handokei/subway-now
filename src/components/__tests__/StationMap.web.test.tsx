import React from 'react';
import { render } from '@testing-library/react-native';
import { StationMap } from '../StationMap.web';
import { Station } from '../../types/station';

const gangnam: Station = {
  id: '2-222',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const sinnonhyeon: Station = {
  id: '9-007',
  name: '신논현',
  line: '9',
  lineColor: '#BDB092',
  lat: 37.5044,
  lng: 127.0245,
};

const defaultProps = {
  userLat: 37.4979,
  userLng: 127.0276,
  nearestStation: null,
  nearbyStations: [],
};

describe('StationMap.web', () => {
  it('nearbyStations이 없으면 안내 문구를 렌더링한다', () => {
    const { getByText } = render(<StationMap {...defaultProps} />);
    expect(getByText('주변 1km 내 지하철역이 없습니다.')).toBeTruthy();
  });

  it('nearbyStations이 있으면 역 목록과 헤더를 렌더링한다', () => {
    const { getByText } = render(
      <StationMap {...defaultProps} nearbyStations={[gangnam, sinnonhyeon]} />,
    );
    expect(getByText('주변 지하철역 (1km 이내)')).toBeTruthy();
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('신논현')).toBeTruthy();
  });

  it('nearestStation과 일치하는 역이 있으면 nearestRow 스타일이 적용된다', () => {
    const { getByText } = render(
      <StationMap
        {...defaultProps}
        nearbyStations={[gangnam, sinnonhyeon]}
        nearestStation={gangnam}
      />,
    );
    expect(getByText('강남')).toBeTruthy();
  });

  it('nearestStation이 목록에 없으면 nearestRow 스타일 없이 렌더링한다', () => {
    const { getByText } = render(
      <StationMap
        {...defaultProps}
        nearbyStations={[sinnonhyeon]}
        nearestStation={gangnam}
      />,
    );
    expect(getByText('신논현')).toBeTruthy();
  });

  it('nearbyStations가 하나일 때 정상 동작한다', () => {
    const { getByText } = render(
      <StationMap {...defaultProps} nearbyStations={[gangnam]} />,
    );
    expect(getByText('강남')).toBeTruthy();
  });
});
