import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';

jest.mock('react-native-webview');
jest.mock('../../utils/buildMapConfig', () => ({
  buildMapConfig: jest.fn(() => ({
    apiKey: 'test-key',
    userLat: 37.498,
    userLng: 127.027,
    stations: [],
  })),
  buildInjectedJS: jest.fn(() => 'window.initMap({}); true;'),
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

  it('로딩 인디케이터를 표시한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('map-loading')).toBeTruthy();
  });

  it('mapLoaded 메시지 수신 시 로딩 인디케이터를 숨긴다', async () => {
    const { getByTestId, queryByTestId } = render(<StationMap {...baseProps} />);
    await act(async () => {
      getByTestId('kakao-map-webview').props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'mapLoaded' }) },
      });
    });
    await waitFor(() => {
      expect(queryByTestId('map-loading')).toBeNull();
    });
  });

  it('buildMapConfig에 올바른 파라미터를 전달한다', () => {
    const { buildMapConfig } = require('../../utils/buildMapConfig');
    render(<StationMap {...baseProps} nearbyStations={[mockStation, anotherStation]} />);
    expect(buildMapConfig).toHaveBeenCalledWith({
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
    act(() => {
      getByTestId('kakao-map-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'stationPress', message: mockStation }),
        },
      });
    });
    expect(onStationPress).toHaveBeenCalledWith(mockStation);
  });

  it('onStationPress가 없을 때 메시지를 받아도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      act(() => {
        getByTestId('kakao-map-webview').props.onMessage({
          nativeEvent: {
            data: JSON.stringify({ type: 'stationPress', message: mockStation }),
          },
        });
      });
    }).not.toThrow();
  });

  it('error 메시지를 받으면 fallback UI를 표시한다', async () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    await act(async () => {
      getByTestId('kakao-map-webview').props.onMessage({
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
    await act(async () => {
      getByTestId('kakao-map-webview').props.onError();
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

  it('WebView의 scrollEnabled이 false이다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('kakao-map-webview').props.scrollEnabled).toBe(false);
  });

  it('API 키가 없으면 fallback UI를 표시한다', () => {
    process.env.EXPO_PUBLIC_KAKAO_MAP_KEY = '';
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('map-no-api-key')).toBeTruthy();
  });

  it('API 키가 undefined이면 fallback UI를 표시한다', () => {
    delete process.env.EXPO_PUBLIC_KAKAO_MAP_KEY;
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('map-no-api-key')).toBeTruthy();
  });
});
