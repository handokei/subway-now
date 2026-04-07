import React from 'react';
import { render } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import { Station } from '../../types/station';

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    WebView: (props: object) => React.createElement(View, { testID: 'webview', ...props }),
  };
});

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const baseProps = {
  userLat: 37.4980,
  userLng: 127.0277,
  nearestStation: mockStation,
  nearbyStations: [mockStation],
};

describe('StationMap', () => {
  it('kakaoKey가 빈 문자열이면 안내 텍스트를 렌더링한다', () => {
    const { getByText } = render(<StationMap {...baseProps} kakaoKey="" />);
    expect(getByText('카카오맵 API 키가 필요합니다.')).toBeTruthy();
    expect(getByText('EXPO_PUBLIC_KAKAO_MAP_KEY를 .env에 설정하세요.')).toBeTruthy();
  });

  it('kakaoKey가 있으면 WebView를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} kakaoKey="test-key" />);
    expect(getByTestId('webview')).toBeTruthy();
  });

  it('nearbyStations가 빈 배열이어도 WebView를 렌더링한다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} kakaoKey="test-key" nearbyStations={[]} />
    );
    expect(getByTestId('webview')).toBeTruthy();
  });

  it('nearestStation이 null이어도 WebView를 렌더링한다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} kakaoKey="test-key" nearestStation={null} />
    );
    expect(getByTestId('webview')).toBeTruthy();
  });
});
