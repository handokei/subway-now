import React from 'react';
import { render } from '@testing-library/react-native';
import { StationMap } from '../StationMap.web';

const defaultProps = {
  userLat: 37.4979,
  userLng: 127.0276,
  nearestStation: null,
  nearbyStations: [],
  kakaoKey: 'test-key',
};

describe('StationMap.web', () => {
  it('모바일 앱 안내 문구를 렌더링한다', () => {
    const { getByText } = render(<StationMap {...defaultProps} />);
    expect(getByText('지도는 모바일 앱(Expo Go)에서 이용하세요.')).toBeTruthy();
  });

  it('kakaoKey가 없어도 동일한 안내 문구를 렌더링한다', () => {
    const { getByText } = render(<StationMap {...defaultProps} kakaoKey="" />);
    expect(getByText('지도는 모바일 앱(Expo Go)에서 이용하세요.')).toBeTruthy();
  });
});
