import React from 'react';
import i18next from 'i18next';
import { StationMap } from '../StationMap.web';
import { Station } from '../../../../shared/types/station';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';

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
    const { getByText } = renderWithTheme(<StationMap {...defaultProps} />);
    expect(getByText(i18next.t('map.noNearbyStations'))).toBeTruthy();
  });

  it('nearbyStations이 있으면 역 목록과 헤더를 렌더링한다', () => {
    const { getByText } = renderWithTheme(
      <StationMap {...defaultProps} nearbyStations={[gangnam, sinnonhyeon]} />,
    );
    expect(getByText(i18next.t('map.nearbyStationsHeader'))).toBeTruthy();
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('신논현')).toBeTruthy();
  });

  it('nearestStation과 일치하는 역이 있으면 nearestRow 스타일이 적용된다', () => {
    const { getByText } = renderWithTheme(
      <StationMap
        {...defaultProps}
        nearbyStations={[gangnam, sinnonhyeon]}
        nearestStation={gangnam}
      />,
    );
    expect(getByText('강남')).toBeTruthy();
  });

  it('nearestStation이 목록에 없으면 nearestRow 스타일 없이 렌더링한다', () => {
    const { getByText } = renderWithTheme(
      <StationMap
        {...defaultProps}
        nearbyStations={[sinnonhyeon]}
        nearestStation={gangnam}
      />,
    );
    expect(getByText('신논현')).toBeTruthy();
  });

  it('nearbyStations가 하나일 때 정상 동작한다', () => {
    const { getByText } = renderWithTheme(
      <StationMap {...defaultProps} nearbyStations={[gangnam]} />,
    );
    expect(getByText('강남')).toBeTruthy();
  });
  describe('routeCoords (경로 표시)', () => {
    const routeCoords = {
      path: [
        { latitude: gangnam.lat, longitude: gangnam.lng },
        { latitude: sinnonhyeon.lat, longitude: sinnonhyeon.lng },
      ],
      keyStations: [
        { station: gangnam, role: 'origin' as const },
        { station: sinnonhyeon, role: 'transfer' as const },
        { station: gangnam, role: 'destination' as const },
      ],
    };

    it('routeCoords가 있으면 경로 섹션과 역할별 키 역을 순서대로 렌더링한다', () => {
      const { getByTestId, getByText } = renderWithTheme(
        <StationMap {...defaultProps} nearbyStations={[gangnam]} routeCoords={routeCoords} />,
      );
      expect(getByTestId('route-section')).toBeTruthy();
      expect(getByText(i18next.t('map.routeHeader'))).toBeTruthy();
      expect(getByText(i18next.t('map.originBadge'))).toBeTruthy();
      expect(getByText(i18next.t('map.transferBadge'))).toBeTruthy();
      expect(getByText(i18next.t('map.destinationBadge'))).toBeTruthy();
      expect(getByTestId('route-station-0-origin')).toBeTruthy();
      expect(getByTestId('route-station-1-transfer')).toBeTruthy();
      expect(getByTestId('route-station-2-destination')).toBeTruthy();
    });

    it('주변 역이 없어도 routeCoords가 있으면 경로 섹션을 렌더링한다', () => {
      const { getByTestId, getByText } = renderWithTheme(
        <StationMap {...defaultProps} routeCoords={routeCoords} />,
      );
      expect(getByTestId('route-section')).toBeTruthy();
      expect(getByText(i18next.t('map.noNearbyStations'))).toBeTruthy();
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['빈 path', { path: [], keyStations: [] }],
    ])('routeCoords가 %s이면 경로 섹션을 렌더링하지 않는다', (_n, value) => {
      const { queryByTestId } = renderWithTheme(
        <StationMap {...defaultProps} nearbyStations={[gangnam]} routeCoords={value} />,
      );
      expect(queryByTestId('route-section')).toBeNull();
    });
  });
});
