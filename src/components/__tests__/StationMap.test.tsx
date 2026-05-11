import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';

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

  it('customOriginId와 일치하는 마커는 accent 색상 dot을 사용한다', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} customOriginId="2-023" />,
    );
    const dot = getByTestId('dot-2-023');
    expect(dot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
  });

  it('customOriginId가 없으면 기존 색상 로직을 따른다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const nearestDot = getByTestId('dot-2-022');
    expect(nearestDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
    const otherDot = getByTestId('dot-2-023');
    expect(otherDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#009D3E' })]),
    );
  });

  it('마커에 역 이름 라벨이 표시된다', () => {
    const { getByText } = render(<StationMap {...baseProps} />);
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('선릉')).toBeTruthy();
  });

  it('모든 마커에 tracksViewChanges={false}가 설정된다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('marker-2-022').props.tracksViewChanges).toBe(false);
    expect(getByTestId('marker-2-023').props.tracksViewChanges).toBe(false);
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
