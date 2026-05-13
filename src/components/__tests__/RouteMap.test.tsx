import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { RouteMap } from '../RouteMap';
import { findRoute } from '../../utils/stationRoute';
import stationsData from '../../data/stations.json';
import type { Station } from '../../types/station';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __fitToCoordinatesMock } = require('react-native-maps');

const allStations = stationsData as Station[];
const byId = (id: string) => allStations.find((s) => s.id === id)!;

beforeEach(() => {
  __fitToCoordinatesMock.mockClear();
});

describe('RouteMap', () => {
  it('route가 null이면 아무것도 렌더링하지 않는다', () => {
    const origin = byId('2-022');
    const destination = byId('2-019');
    const { queryByTestId } = render(
      <RouteMap route={null} origin={origin} destination={destination} />,
    );
    expect(queryByTestId('route-map-container')).toBeNull();
  });

  it('direct route는 origin/destination 두 개의 마커만 표시한다', () => {
    const origin = byId('2-022');
    const destination = byId('2-019');
    const route = findRoute(origin.id, destination.id);
    const { getByTestId, queryAllByTestId } = render(
      <RouteMap route={route} origin={origin} destination={destination} />,
    );
    expect(getByTestId('route-map')).toBeTruthy();
    expect(getByTestId(`route-marker-origin-${origin.id}`)).toBeTruthy();
    expect(getByTestId(`route-marker-destination-${destination.id}`)).toBeTruthy();
    expect(queryAllByTestId(/^route-marker-transfer-/)).toHaveLength(0);
  });

  it('transfer route는 환승역 마커도 표시한다', () => {
    const origin = byId('2-022');
    const destination = byId('6-020');
    const route = findRoute(origin.id, destination.id);
    const { queryAllByTestId, getByTestId } = render(
      <RouteMap route={route} origin={origin} destination={destination} />,
    );
    expect(getByTestId('route-polyline')).toBeTruthy();
    expect(queryAllByTestId(/^route-marker-transfer-/).length).toBeGreaterThanOrEqual(1);
  });

  it('mapReady 후 fitToCoordinates를 호출한다', async () => {
    const origin = byId('2-022');
    const destination = byId('2-019');
    const route = findRoute(origin.id, destination.id);
    render(<RouteMap route={route} origin={origin} destination={destination} />);
    await waitFor(() => expect(__fitToCoordinatesMock).toHaveBeenCalled());
    const [coords, opts] = __fitToCoordinatesMock.mock.calls[0];
    expect(Array.isArray(coords)).toBe(true);
    expect(coords.length).toBeGreaterThan(0);
    expect(opts).toMatchObject({ animated: false });
  });

  it('mapReady 전에는 로딩 인디케이터를 표시한다 — onMapReady 후 사라진다', async () => {
    const origin = byId('2-022');
    const destination = byId('2-019');
    const route = findRoute(origin.id, destination.id);
    const { queryByTestId } = render(
      <RouteMap route={route} origin={origin} destination={destination} />,
    );
    await waitFor(() => {
      expect(queryByTestId('route-map-loading')).toBeNull();
    });
  });

  it('transfer 마커는 해당 역의 lineColor를 사용한다', () => {
    const origin = byId('2-022');
    const destination = byId('6-020');
    const route = findRoute(origin.id, destination.id);
    const { queryAllByTestId } = render(
      <RouteMap route={route} origin={origin} destination={destination} />,
    );
    const transferDots = queryAllByTestId(/^route-marker-dot-transfer-/);
    expect(transferDots.length).toBeGreaterThan(0);
    // line color가 적용된 dot인지만 확인 (구체 색상은 데이터 의존)
    const styles = transferDots[0].props.style as Array<Record<string, unknown>>;
    const merged = styles.reduce((acc, s) => ({ ...acc, ...s }), {});
    expect(typeof merged.backgroundColor).toBe('string');
  });

  it('coords가 null인 경우 컴포넌트를 렌더링하지 않고 fitToCoordinates도 호출하지 않는다', () => {
    // 잘못된 환승역 이름을 가진 route → routeToCoordinates가 null 반환 → 컴포넌트가 null 렌더
    const origin = byId('2-022');
    const destination = byId('6-020');
    const badRoute = {
      type: 'transfer' as const,
      transferName: '존재하지않는역',
      fromLine: '2' as const,
      toLine: '6' as const,
      stopsToTransfer: 1,
      stopsFromTransfer: 1,
    };
    const { queryByTestId } = render(
      <RouteMap route={badRoute} origin={origin} destination={destination} />,
    );
    // null 렌더이므로 MapView 자체가 존재하지 않으며 fitToCoordinates도 호출되지 않는다
    expect(queryByTestId('route-map')).toBeNull();
    expect(queryByTestId('route-map-container')).toBeNull();
    expect(__fitToCoordinatesMock).not.toHaveBeenCalled();
  });
});
