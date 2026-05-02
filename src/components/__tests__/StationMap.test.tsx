import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';

jest.mock('react-native-webview');
jest.mock('../../utils/buildMapHtml', () => ({
  buildMapHtml: jest.fn(() => '<html>mock</html>'),
}));

const originalEnv = process.env.EXPO_PUBLIC_KAKAO_MAP_KEY;

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
  beforeEach(() => {
    process.env.EXPO_PUBLIC_KAKAO_MAP_KEY = 'test-key';
  });

  afterEach(() => {
    process.env.EXPO_PUBLIC_KAKAO_MAP_KEY = originalEnv;
  });

  it('WebView를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('kakao-map-webview')).toBeTruthy();
  });

  it('buildMapHtml에 올바른 파라미터를 전달한다', () => {
    const { buildMapHtml } = require('../../utils/buildMapHtml');
    render(<StationMap {...baseProps} nearbyStations={[mockStation, anotherStation]} />);
    expect(buildMapHtml).toHaveBeenCalledWith({
      apiKey: 'test-key',
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
    act(() => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'stationPress', station: mockStation }),
        },
      });
    });
    expect(onStationPress).toHaveBeenCalledWith(mockStation);
  });

  it('onStationPress가 없을 때 메시지를 받아도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const webview = getByTestId('kakao-map-webview');
    expect(() => {
      act(() => {
        webview.props.onMessage({
          nativeEvent: {
            data: JSON.stringify({ type: 'stationPress', station: mockStation }),
          },
        });
      });
    }).not.toThrow();
  });

  it('error 메시지를 받으면 fallback UI를 표시한다', async () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const webview = getByTestId('kakao-map-webview');
    await act(async () => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'error', message: 'SDK 로드 실패' }),
        },
      });
    });
    await waitFor(() => {
      expect(getByTestId('map-error')).toBeTruthy();
    });
  });

  it('onError 발생 시 fallback UI를 표시한다', async () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const webview = getByTestId('kakao-map-webview');
    await act(async () => {
      webview.props.onError();
    });
    await waitFor(() => {
      expect(getByTestId('map-error')).toBeTruthy();
    });
  });

  it('잘못된 JSON 메시지를 받아도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      act(() => {
        getByTestId('kakao-map-webview').props.onMessage({
          nativeEvent: { data: 'invalid json' },
        });
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

  it('API 키가 없으면 fallback UI를 표시한다', () => {
    process.env.EXPO_PUBLIC_KAKAO_MAP_KEY = '';
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('map-no-api-key')).toBeTruthy();
  });
});
