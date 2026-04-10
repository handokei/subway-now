import React from 'react';
import { render } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import { Station } from '../../types/station';

jest.mock('@mj-studio/react-native-naver-map');

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
  it('NaverMapView를 렌더링한다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('naver-map-view')).toBeTruthy();
  });

  it('nearbyStations의 각 역마다 마커를 렌더링한다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} nearbyStations={[mockStation, anotherStation]} />
    );
    expect(getByTestId(`marker-${mockStation.id}`)).toBeTruthy();
    expect(getByTestId(`marker-${anotherStation.id}`)).toBeTruthy();
  });

  it('nearbyStations가 빈 배열이면 마커 없이 렌더링한다', () => {
    const { getByTestId, queryByTestId } = render(
      <StationMap {...baseProps} nearbyStations={[]} />
    );
    expect(getByTestId('naver-map-view')).toBeTruthy();
    expect(queryByTestId(`marker-${mockStation.id}`)).toBeNull();
  });

  it('nearestStation과 일치하는 마커는 크기가 36이다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const marker = getByTestId(`marker-${mockStation.id}`);
    expect(marker.props.width).toBe(36);
    expect(marker.props.height).toBe(36);
  });

  it('nearestStation과 일치하지 않는 마커는 크기가 24이다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} nearbyStations={[mockStation, anotherStation]} />
    );
    const marker = getByTestId(`marker-${anotherStation.id}`);
    expect(marker.props.width).toBe(24);
    expect(marker.props.height).toBe(24);
  });

  it('nearestStation이 null이면 모든 마커 크기가 24이다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} nearestStation={null} />
    );
    const marker = getByTestId(`marker-${mockStation.id}`);
    expect(marker.props.width).toBe(24);
  });

  it('onStationPress가 있으면 마커 onTap 호출 시 station을 전달한다', () => {
    const onStationPress = jest.fn();
    const { getByTestId } = render(
      <StationMap {...baseProps} onStationPress={onStationPress} />
    );
    getByTestId(`marker-${mockStation.id}`).props.onTap();
    expect(onStationPress).toHaveBeenCalledWith(mockStation);
  });

  it('onStationPress가 없을 때 마커 onTap 호출해도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      getByTestId(`marker-${mockStation.id}`).props.onTap();
    }).not.toThrow();
  });
});
