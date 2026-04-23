import React from 'react';
import { render } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';

jest.mock('react-native-webview');
jest.mock('../../utils/buildMapHtml', () => ({
  buildMapHtml: jest.fn(() => '<html>mock</html>'),
}));

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const anotherStation: Station = {
  id: '2-023',
  name: '선릉',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5044,
  lng: 127.0491,
};

const baseProps = {
  userLat: 37.498,
  userLng: 127.027,
  nearestStation: mockStation,
  nearbyStations: [mockStation],
};

describe('StationMap', () => {
  it('WebView를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('kakao-map-webview')).toBeTruthy();
  });

  it('buildMapHtml에 올바른 파라미터를 전달한다', () => {
    const { buildMapHtml } = require('../../utils/buildMapHtml');
    render(<StationMap {...baseProps} nearbyStations={[mockStation, anotherStation]} />);
    expect(buildMapHtml).toHaveBeenCalledWith({
      apiKey: expect.any(String),
      userLat: 37.498,
      userLng: 127.027,
      nearestStation: mockStation,
      nearbyStations: [mockStation, anotherStation],
    });
  });

  it('stationPress 메시지를 받으면 onStationPress를 호출한다', () => {
    const onStationPress = jest.fn();
    const { getByTestId } = render(
      <StationMap {...baseProps} onStationPress={onStationPress} />,
    );
    const webview = getByTestId('kakao-map-webview');
    webview.props.onMessage({
      nativeEvent: {
        data: JSON.stringify({ type: 'stationPress', station: mockStation }),
      },
    });
    expect(onStationPress).toHaveBeenCalledWith(mockStation);
  });

  it('onStationPress가 없을 때 메시지를 받아도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const webview = getByTestId('kakao-map-webview');
    expect(() => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'stationPress', station: mockStation }),
        },
      });
    }).not.toThrow();
  });

  it('stationPress가 아닌 메시지는 무시한다', () => {
    const onStationPress = jest.fn();
    const { getByTestId } = render(
      <StationMap {...baseProps} onStationPress={onStationPress} />,
    );
    getByTestId('kakao-map-webview').props.onMessage({
      nativeEvent: { data: JSON.stringify({ type: 'other' }) },
    });
    expect(onStationPress).not.toHaveBeenCalled();
  });

  it('잘못된 JSON 메시지를 받아도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      getByTestId('kakao-map-webview').props.onMessage({
        nativeEvent: { data: 'invalid json' },
      });
    }).not.toThrow();
  });

  it('WebView에 html source가 전달된다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('kakao-map-webview').props.source).toEqual({
      html: '<html>mock</html>',
    });
  });

  it('WebView의 scrollEnabled이 false이다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('kakao-map-webview').props.scrollEnabled).toBe(false);
  });
});
