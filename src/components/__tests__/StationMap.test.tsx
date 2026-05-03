import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';

jest.mock('react-native-maps', () => {
  const RN = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: ({ children, testID, onMapReady, ...props }: any) => {
      R.useEffect(() => { onMapReady?.(); }, []);
      return R.createElement(RN.View, { testID, ...props }, children);
    },
    Marker: ({ testID, onPress, ...props }: any) =>
      R.createElement(RN.View, { testID, onPress, ...props }),
    PROVIDER_DEFAULT: null,
  };
});

jest.mock('react-native-map-clustering', () => {
  const RN = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: ({ children, testID, onMapReady, ...props }: any) => {
      R.useEffect(() => { onMapReady?.(); }, []);
      return R.createElement(RN.View, { testID, ...props }, children);
    },
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
  nearbyStations: [mockStation, anotherStation],
};

describe('StationMap', () => {
  it('지도뷰를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('station-map')).toBeTruthy();
  });

  it('onMapReady 후 로딩 인디케이터를 숨긴다', async () => {
    const { queryByTestId } = render(<StationMap {...baseProps} />);
    await waitFor(() => {
      expect(queryByTestId('map-loading')).toBeNull();
    });
  });

  it('nearbyStations 수만큼 마커를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('marker-2-022')).toBeTruthy();
    expect(getByTestId('marker-2-023')).toBeTruthy();
  });

  it('마커 press 시 onStationPress를 호출한다', () => {
    const onStationPress = jest.fn();
    const { getByTestId } = render(
      <StationMap {...baseProps} onStationPress={onStationPress} />,
    );
    fireEvent.press(getByTestId('marker-2-022'));
    expect(onStationPress).toHaveBeenCalledWith(
      expect.objectContaining({ id: '2-022', name: '강남' }),
    );
  });

  it('onStationPress가 없을 때 마커 press해도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      fireEvent.press(getByTestId('marker-2-022'));
    }).not.toThrow();
  });

  it('nearbyStations가 빈 배열이면 마커가 없다', () => {
    const { queryByTestId } = render(
      <StationMap {...baseProps} nearbyStations={[]} />,
    );
    expect(queryByTestId('marker-2-022')).toBeNull();
  });

  it('showsUserLocation이 true이다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('station-map').props.showsUserLocation).toBe(true);
  });

  it('customOriginId와 일치하는 마커는 accent 색상을 사용한다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} customOriginId="2-023" />,
    );
    // customOriginId와 일치하는 마커의 pinColor가 accent 색상(테마 기본: #C8553D)
    const marker = getByTestId('marker-2-023');
    expect(marker.props.pinColor).toBe('#C8553D');
  });

  it('customOriginId가 없으면 기존 색상 로직을 따른다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    // nearest station은 accent, 나머지는 lineColor
    const nearestMarker = getByTestId('marker-2-022');
    expect(nearestMarker.props.pinColor).toBe('#C8553D');
    const otherMarker = getByTestId('marker-2-023');
    expect(otherMarker.props.pinColor).toBe('#009D3E');
  });

  it('buildMapConfig에 올바른 파라미터를 전달한다', () => {
    const buildMapConfig = jest.requireActual('../../utils/buildMapConfig').buildMapConfig;
    const result = buildMapConfig({
      userLat: 37.498,
      userLng: 127.027,
      nearestStation: mockStation,
      nearbyStations: [mockStation, anotherStation],
    });
    expect(result.stations[0].isNearest).toBe(true);
    expect(result.stations[1].isNearest).toBe(false);
  });
});
