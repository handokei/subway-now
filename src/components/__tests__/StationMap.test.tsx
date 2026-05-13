import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';
import { installLanguageRestoreHook, setLang } from '../../testUtils/i18nLanguageOverride';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __animateToRegionMock, __fitToCoordinatesMock } = require('react-native-map-clustering');

installLanguageRestoreHook();

beforeEach(() => {
  __animateToRegionMock.mockClear();
  __fitToCoordinatesMock.mockClear();
});

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  nameEn: 'Gangnam',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const anotherStation: Station = {
  id: '2-023',
  name: '선릉',
  nameEn: 'Seolleung',
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

  it('마커 dot이 흰색 테두리와 확대된 크기(14)를 가진다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const dot = getByTestId('dot-2-023');
    expect(dot.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: '#ffffff',
        }),
      ]),
    );
  });

  it('마커 라벨이 흰 pill 위에 검정 텍스트(#111, 12px)로 표시된다', () => {
    const { getByText, getByTestId } = render(<StationMap {...baseProps} />);
    const label = getByText('강남');
    expect(label.props.style).toEqual(
      expect.objectContaining({
        fontSize: 12,
        color: '#111111',
      }),
    );
    expect(getByTestId('label-pill-2-022').props.style).toEqual(
      expect.objectContaining({
        backgroundColor: 'rgba(255,255,255,0.92)',
      }),
    );
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

  it('영어 모드에서 마커 라벨이 nameEn으로 표시된다', () => {
    setLang('en');
    const { getByText } = render(<StationMap {...baseProps} />);
    expect(getByText('Gangnam')).toBeTruthy();
    expect(getByText('Seolleung')).toBeTruthy();
  });

  it('영어 모드에서 마커 title이 nameEn으로 설정된다', () => {
    setLang('en');
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('marker-2-022').props.title).toBe('Gangnam');
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

  describe('focusStation', () => {
    it('focusStation 미전달 시 animateToRegion 호출 안 함', () => {
      render(<StationMap {...baseProps} />);
      expect(__animateToRegionMock).not.toHaveBeenCalled();
    });

    it('focusStation 전달 시 해당 좌표로 animateToRegion 호출', () => {
      render(<StationMap {...baseProps} focusStation={anotherStation} />);
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: anotherStation.lat,
          longitude: anotherStation.lng,
        }),
        expect.any(Number),
      );
    });

    it('focusStation 변경 시 새 좌표로 재호출', () => {
      const { rerender } = render(
        <StationMap {...baseProps} focusStation={mockStation} />,
      );
      __animateToRegionMock.mockClear();
      rerender(<StationMap {...baseProps} focusStation={anotherStation} />);
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: anotherStation.lat,
          longitude: anotherStation.lng,
        }),
        expect.any(Number),
      );
    });

    it('같은 역을 다시 선택해도 focusNonce 변경 시 재이동', () => {
      const { rerender } = render(
        <StationMap {...baseProps} focusStation={mockStation} focusNonce={1} />,
      );
      __animateToRegionMock.mockClear();
      rerender(<StationMap {...baseProps} focusStation={mockStation} focusNonce={2} />);
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: mockStation.lat,
          longitude: mockStation.lng,
        }),
        expect.any(Number),
      );
    });

    it('focusStation을 null로 바꾸면 추가 호출 없음', () => {
      const { rerender } = render(
        <StationMap {...baseProps} focusStation={mockStation} />,
      );
      __animateToRegionMock.mockClear();
      rerender(<StationMap {...baseProps} focusStation={null} />);
      expect(__animateToRegionMock).not.toHaveBeenCalled();
    });
  });

  describe('recenterNonce', () => {
    it('recenterNonce 미전달 시 animateToRegion 호출 안 함', () => {
      render(<StationMap {...baseProps} />);
      expect(__animateToRegionMock).not.toHaveBeenCalled();
    });

    it('recenterNonce 전달 시 사용자 좌표로 animateToRegion 호출', () => {
      render(<StationMap {...baseProps} recenterNonce={1} />);
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: baseProps.userLat,
          longitude: baseProps.userLng,
        }),
        expect.any(Number),
      );
    });

    it('recenterNonce 변경 시 사용자 좌표로 재호출', () => {
      const { rerender } = render(
        <StationMap {...baseProps} recenterNonce={1} />,
      );
      __animateToRegionMock.mockClear();
      rerender(<StationMap {...baseProps} recenterNonce={2} />);
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: baseProps.userLat,
          longitude: baseProps.userLng,
        }),
        expect.any(Number),
      );
    });

    it('GPS 좌표가 갱신된 뒤 nonce 변경 시 최신 좌표로 이동 (no stale closure)', () => {
      const { rerender } = render(
        <StationMap {...baseProps} recenterNonce={1} />,
      );
      rerender(
        <StationMap {...baseProps} userLat={37.6} userLng={127.1} recenterNonce={1} />,
      );
      __animateToRegionMock.mockClear();
      rerender(
        <StationMap {...baseProps} userLat={37.6} userLng={127.1} recenterNonce={2} />,
      );
      expect(__animateToRegionMock).toHaveBeenCalledWith(
        expect.objectContaining({ latitude: 37.6, longitude: 127.1 }),
        expect.any(Number),
      );
    });
  });

  describe('trainMarkers (Phase 3 Stage 3)', () => {
    const mkTrain = (trainNo: string, status: number) => ({
      trainNo,
      line: '2' as const,
      lineColor: '#009D3E',
      lat: 37.498,
      lng: 127.028,
      statnNm: '강남',
      trainStatus: status,
      updnLine: 0,
      terminalStationName: '성수',
    });

    it('trainMarkers 미전달 시 train 마커 0개', () => {
      const { queryAllByTestId } = render(<StationMap {...baseProps} />);
      expect(queryAllByTestId(/^train-marker-/)).toHaveLength(0);
    });

    it('trainMarkers 전달 시 trainNo로 마커 렌더', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 1), mkTrain('T002', 0)]} />,
      );
      expect(getByTestId('train-marker-T001')).toBeTruthy();
      expect(getByTestId('train-marker-T002')).toBeTruthy();
    });

    it('도착(1) description에 "도착"', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 1)]} />,
      );
      expect(getByTestId('train-marker-T001').props.description).toContain('도착');
    });

    it('진입(0) description에 "진입"', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 0)]} />,
      );
      expect(getByTestId('train-marker-T001').props.description).toContain('진입');
    });

    it('출발(2) description에 "출발"', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 2)]} />,
      );
      expect(getByTestId('train-marker-T001').props.description).toContain('출발');
    });

    it('전역 출발(3) → "전역 출발"', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 3)]} />,
      );
      expect(getByTestId('train-marker-T001').props.description).toContain('전역 출발');
    });

    it('알 수 없는 status → "운행 중"', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} trainMarkers={[mkTrain('T001', 99)]} />,
      );
      expect(getByTestId('train-marker-T001').props.description).toContain('운행 중');
    });
  });

  describe('routeCoords (경로 오버레이)', () => {
    const transferStation: Station = {
      id: '3-329',
      name: '교대',
      nameEn: 'Seoul Nat\'l Univ. of Education',
      line: '3',
      lineColor: '#EF7C1C',
      lat: 37.4933,
      lng: 127.0146,
    };
    const destStation: Station = {
      id: '3-330',
      name: '남부터미널',
      nameEn: 'Express Bus Terminal',
      line: '3',
      lineColor: '#EF7C1C',
      lat: 37.4847,
      lng: 127.0156,
    };

    const path = [
      { latitude: mockStation.lat, longitude: mockStation.lng },
      { latitude: transferStation.lat, longitude: transferStation.lng },
      { latitude: destStation.lat, longitude: destStation.lng },
    ];
    const routeCoords = {
      path,
      keyStations: [
        { station: mockStation, role: 'origin' as const },
        { station: transferStation, role: 'transfer' as const },
        { station: destStation, role: 'destination' as const },
      ],
    };

    it('routeCoords 미전달 시 polyline / 강조 마커가 없다', () => {
      const { queryByTestId } = render(<StationMap {...baseProps} />);
      expect(queryByTestId('route-polyline')).toBeNull();
      expect(queryByTestId(`route-marker-origin-${mockStation.id}`)).toBeNull();
    });

    it('routeCoords 전달 시 polyline + 출발/환승/도착 마커 렌더', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} routeCoords={routeCoords} />,
      );
      expect(getByTestId('route-polyline')).toBeTruthy();
      expect(getByTestId(`route-marker-origin-${mockStation.id}`)).toBeTruthy();
      expect(getByTestId(`route-marker-transfer-${transferStation.id}`)).toBeTruthy();
      expect(getByTestId(`route-marker-destination-${destStation.id}`)).toBeTruthy();
    });

    it('routeCoords 전달 시 fitToCoordinates 호출', async () => {
      render(<StationMap {...baseProps} routeCoords={routeCoords} />);
      await waitFor(() => {
        expect(__fitToCoordinatesMock).toHaveBeenCalledWith(
          routeCoords.path,
          expect.objectContaining({ animated: true }),
        );
      });
    });

    it('routeCoords.path가 비어 있으면 fitToCoordinates 호출 안 함', async () => {
      render(
        <StationMap
          {...baseProps}
          routeCoords={{ path: [], keyStations: [] }}
        />,
      );
      await waitFor(() => {
        // map ready effect 트리거를 위해 한 차례 flush
        expect(__animateToRegionMock).not.toHaveBeenCalled();
      });
      expect(__fitToCoordinatesMock).not.toHaveBeenCalled();
    });

    it('환승 마커는 노선 색, 출발/도착 마커는 accent 색을 사용', () => {
      const { getByTestId } = render(
        <StationMap {...baseProps} routeCoords={routeCoords} />,
      );
      const transferDot = getByTestId(`route-marker-dot-transfer-${transferStation.id}`);
      expect(transferDot.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backgroundColor: transferStation.lineColor }),
        ]),
      );
      const originDot = getByTestId(`route-marker-dot-origin-${mockStation.id}`);
      expect(originDot.props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
      );
    });
  });
});
