import React from 'react';
import { Platform } from 'react-native';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
import { StationMap } from '../StationMap';
import type { Station } from '../../types/station';
import { installLanguageRestoreHook, setLang } from '../../testUtils/i18nLanguageOverride';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __animateToRegionMock, __fitToCoordinatesMock } = require('react-native-maps');

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

const cheongguL5: Station = {
  id: '5-540',
  name: '청구',
  nameEn: 'Cheonggu',
  line: '5',
  lineColor: '#996CAC',
  lat: 37.5605,
  lng: 127.0136,
};

const cheongguL6: Station = {
  id: '6-636',
  name: '청구',
  nameEn: 'Cheonggu',
  line: '6',
  lineColor: '#CD7C2F',
  lat: 37.5605,
  lng: 127.0136,
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

  it('iOS에서는 Apple Maps의 기본 POI(역명 등)를 끈다 — 경로 강조 마커와 중첩 방지', () => {
    const originalOS = Platform.OS;
    (Platform as { OS: typeof Platform.OS }).OS = 'ios';
    try {
      const { getByTestId } = render(<StationMap {...baseProps} />);
      expect(getByTestId('station-map').props.showsPointsOfInterest).toBe(false);
    } finally {
      (Platform as { OS: typeof Platform.OS }).OS = originalOS;
    }
  });

  it('Android에서는 POI 토글을 건드리지 않는다 (일반 POI 손실 방지)', () => {
    const originalOS = Platform.OS;
    (Platform as { OS: typeof Platform.OS }).OS = 'android';
    try {
      const { getByTestId } = render(<StationMap {...baseProps} />);
      expect(getByTestId('station-map').props.showsPointsOfInterest).toBeUndefined();
    } finally {
      (Platform as { OS: typeof Platform.OS }).OS = originalOS;
    }
  });

  it('onMapReady 후 로딩 인디케이터를 숨긴다', async () => {
    const { queryByTestId } = render(<StationMap {...baseProps} />);
    await waitFor(() => {
      expect(queryByTestId('map-loading')).toBeNull();
    });
  });

  it('각 역마다 그룹 마커를 1개 렌더링한다 (단일 호선)', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('marker-강남')).toBeTruthy();
    expect(getByTestId('marker-선릉')).toBeTruthy();
  });

  it('환승역은 1개 마커에 호선 수만큼 배지를 그린다', () => {
    const { getByTestId, queryAllByTestId } = render(
      <StationMap
        {...baseProps}
        nearestStation={null}
        nearbyStations={[cheongguL5, cheongguL6]}
      />,
    );
    expect(getByTestId('marker-청구')).toBeTruthy();
    expect(getByTestId('badge-5-540')).toBeTruthy();
    expect(getByTestId('badge-6-636')).toBeTruthy();
    // 라벨 pill은 그룹당 1개
    expect(queryAllByTestId('label-pill-청구')).toHaveLength(1);
  });

  // #433: 데이터상 좌표 중복 그룹 9개 환승역이 모두 단일 그룹 마커로 렌더되는지 검증.
  // 본문 가설("모바일에 그룹화 미적용")이 사실이면 이 테스트는 멤버 수(21)만큼 마커가 떠 실패한다.
  it('#433 회귀: 9개 환승역 모두 단일 그룹 마커로 렌더된다', () => {
    const transferStations: Station[] = [
      // 창동 1/4
      { id: '1-017', name: '창동', nameEn: 'Chang-dong', line: '1', lineColor: '#0052A4', lat: 37.65309, lng: 127.04727 },
      { id: '4-004', name: '창동', nameEn: 'Chang-dong', line: '4', lineColor: '#00A5DE', lat: 37.65309, lng: 127.04727 },
      // 외대앞 1/경의
      { id: '1-023', name: '외대앞', nameEn: 'HUFS', line: '1', lineColor: '#0052A4', lat: 37.59607, lng: 127.06355 },
      { id: 'gyeongui-036', name: '외대앞', nameEn: 'HUFS', line: 'gyeongui', lineColor: '#77C4A3', lat: 37.59607, lng: 127.06355 },
      // 회기 1/경의
      { id: '1-024', name: '회기', nameEn: 'Hoegi', line: '1', lineColor: '#0052A4', lat: 37.58946, lng: 127.05758 },
      { id: 'gyeongui-037', name: '회기', nameEn: 'Hoegi', line: 'gyeongui', lineColor: '#77C4A3', lat: 37.58946, lng: 127.05758 },
      // 청량리 1/경의(서울시립대입구)/분당
      { id: '1-025', name: '청량리', nameEn: 'Cheongnyangni', line: '1', lineColor: '#0052A4', lat: 37.58076, lng: 127.04830 },
      { id: 'gyeongui-035', name: '청량리(서울시립대입구)', nameEn: 'Cheongnyangni', line: 'gyeongui', lineColor: '#77C4A3', lat: 37.58076, lng: 127.04830 },
      { id: 'bundang-054', name: '청량리', nameEn: 'Cheongnyangni', line: 'bundang', lineColor: '#FABE00', lat: 37.58076, lng: 127.04830 },
      // 용산 1/경의
      { id: '1-036', name: '용산', nameEn: 'Yongsan', line: '1', lineColor: '#0052A4', lat: 37.52985, lng: 126.96456 },
      { id: 'gyeongui-028', name: '용산', nameEn: 'Yongsan', line: 'gyeongui', lineColor: '#77C4A3', lat: 37.52985, lng: 126.96456 },
      // 신사 3/신분당
      { id: '3-029', name: '신사', nameEn: 'Sinsa', line: '3', lineColor: '#EF7C1C', lat: 37.51633, lng: 127.02011 },
      { id: 'sinbundang-016', name: '신사', nameEn: 'Sinsa', line: 'sinbundang', lineColor: '#D31145', lat: 37.51633, lng: 127.02011 },
      // 논현 7/신분당
      { id: '7-024', name: '논현', nameEn: 'Nonhyeon', line: '7', lineColor: '#747F00', lat: 37.51109, lng: 127.02142 },
      { id: 'sinbundang-015', name: '논현', nameEn: 'Nonhyeon', line: 'sinbundang', lineColor: '#D31145', lat: 37.51109, lng: 127.02142 },
      // 신논현 9/신분당
      { id: '9-025', name: '신논현', nameEn: 'Sinnonhyeon', line: '9', lineColor: '#BDB092', lat: 37.50460, lng: 127.02506 },
      { id: 'sinbundang-014', name: '신논현', nameEn: 'Sinnonhyeon', line: 'sinbundang', lineColor: '#D31145', lat: 37.50460, lng: 127.02506 },
      // 왕십리 2/5/경의(성동구청)/분당
      { id: '2-008', name: '왕십리', nameEn: 'Wangsimni', line: '2', lineColor: '#009D3E', lat: 37.56124, lng: 127.03695 },
      { id: '5-031', name: '왕십리', nameEn: 'Wangsimni', line: '5', lineColor: '#996CAC', lat: 37.56184, lng: 127.03706 },
      { id: 'gyeongui-034', name: '왕십리(성동구청)', nameEn: 'Wangsimni', line: 'gyeongui', lineColor: '#77C4A3', lat: 37.56183, lng: 127.03835 },
      { id: 'bundang-053', name: '왕십리', nameEn: 'Wangsimni', line: 'bundang', lineColor: '#FABE00', lat: 37.56183, lng: 127.03835 },
    ];

    const expectedGroups: Array<{ key: string; memberIds: string[] }> = [
      { key: '창동', memberIds: ['1-017', '4-004'] },
      { key: '외대앞', memberIds: ['1-023', 'gyeongui-036'] },
      { key: '회기', memberIds: ['1-024', 'gyeongui-037'] },
      { key: '청량리', memberIds: ['1-025', 'gyeongui-035', 'bundang-054'] },
      { key: '용산', memberIds: ['1-036', 'gyeongui-028'] },
      { key: '신사', memberIds: ['3-029', 'sinbundang-016'] },
      { key: '논현', memberIds: ['7-024', 'sinbundang-015'] },
      { key: '신논현', memberIds: ['9-025', 'sinbundang-014'] },
      { key: '왕십리', memberIds: ['2-008', '5-031', 'gyeongui-034', 'bundang-053'] },
    ];

    const { getByTestId, queryAllByTestId } = render(
      <StationMap
        {...baseProps}
        nearestStation={null}
        nearbyStations={transferStations}
      />,
    );

    for (const { key, memberIds } of expectedGroups) {
      // 그룹당 마커 1개
      expect(getByTestId(`marker-${key}`)).toBeTruthy();
      // 라벨 pill도 그룹당 1개 (멤버 수와 무관)
      expect(queryAllByTestId(`label-pill-${key}`)).toHaveLength(1);
      // 배지는 멤버 수만큼
      for (const id of memberIds) {
        expect(getByTestId(`badge-${id}`)).toBeTruthy();
      }
    }
  });

  it('마커 press 시 onStationPress에 대표 station을 전달한다', () => {
    const onStationPress = jest.fn();
    const { getByTestId } = render(
      <StationMap {...baseProps} onStationPress={onStationPress} />,
    );
    fireEvent.press(getByTestId('marker-강남'));
    expect(onStationPress).toHaveBeenCalledWith(
      expect.objectContaining({ id: '2-022', name: '강남' }),
    );
  });

  it('onStationPress가 없을 때 마커 press해도 에러가 없다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(() => {
      fireEvent.press(getByTestId('marker-강남'));
    }).not.toThrow();
  });

  it('nearbyStations가 빈 배열이면 마커가 없다', () => {
    const { queryByTestId } = render(<StationMap {...baseProps} nearbyStations={[]} />);
    expect(queryByTestId('marker-강남')).toBeNull();
  });

  it('showsUserLocation이 true이다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('station-map').props.showsUserLocation).toBe(true);
  });

  it('배지는 노선 색을 배경으로 사용한다', () => {
    const { getByTestId } = render(
      <StationMap
        {...baseProps}
        nearestStation={null}
        nearbyStations={[anotherStation]}
      />,
    );
    const badge = getByTestId('badge-2-023');
    expect(badge.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#009D3E' })]),
    );
  });

  it('nearestStation이 속한 그룹의 모든 배지를 accent 색으로 강조', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    const badge = getByTestId('badge-2-022');
    expect(badge.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
  });

  it('customOriginId가 속한 그룹의 모든 배지를 accent 색으로 강조', () => {
    const { getByTestId } = render(
      <StationMap {...baseProps} customOriginId="2-023" />,
    );
    const badge = getByTestId('badge-2-023');
    expect(badge.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
  });

  it('환승역 그룹에서 customOriginId와 매칭된 호선 배지만 accent, 다른 호선 배지는 노선 색 유지', () => {
    const { getByTestId } = render(
      <StationMap
        {...baseProps}
        nearestStation={null}
        nearbyStations={[cheongguL5, cheongguL6]}
        customOriginId="5-540"
      />,
    );
    const highlighted = getByTestId('badge-5-540');
    const other = getByTestId('badge-6-636');
    expect(highlighted.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
    expect(other.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#CD7C2F' })]),
    );
  });

  it('환승역 그룹에서 nearestStation과 매칭된 호선 배지만 accent', () => {
    const { getByTestId } = render(
      <StationMap
        {...baseProps}
        nearestStation={cheongguL6}
        nearbyStations={[cheongguL5, cheongguL6]}
      />,
    );
    const highlighted = getByTestId('badge-6-636');
    const other = getByTestId('badge-5-540');
    expect(highlighted.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#C8553D' })]),
    );
    expect(other.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#996CAC' })]),
    );
  });

  it('마커 라벨이 흰 pill 위에 검정 텍스트(#111, 12px)로 표시된다', () => {
    const { getByText, getByTestId } = render(<StationMap {...baseProps} />);
    const label = getByText('강남');
    expect(label.props.style).toEqual(
      expect.objectContaining({ fontSize: 12, color: '#111111' }),
    );
    expect(getByTestId('label-pill-강남').props.style).toEqual(
      expect.objectContaining({ backgroundColor: 'rgba(255,255,255,0.92)' }),
    );
  });

  it('마커에 역 이름 라벨이 표시된다', () => {
    const { getByText } = render(<StationMap {...baseProps} />);
    expect(getByText('강남')).toBeTruthy();
    expect(getByText('선릉')).toBeTruthy();
  });

  it('모든 마커에 tracksViewChanges={false}가 설정된다', () => {
    const { getByTestId } = render(<StationMap {...baseProps} />);
    expect(getByTestId('marker-강남').props.tracksViewChanges).toBe(false);
    expect(getByTestId('marker-선릉').props.tracksViewChanges).toBe(false);
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
    expect(getByTestId('marker-강남').props.title).toBe('Gangnam');
  });

  it('buildMapConfig에 올바른 파라미터를 전달한다', () => {
    const buildMapConfig = jest.requireActual('../../utils/buildMapConfig').buildMapConfig;
    const result = buildMapConfig({
      userLat: 37.498,
      userLng: 127.027,
      nearestStation: mockStation,
      nearbyStations: [mockStation, anotherStation],
    });
    const nearestGroup = result.groups.find((g: { stations: Station[] }) =>
      g.stations.some((s: Station) => s.id === mockStation.id),
    );
    expect(nearestGroup.isNearest).toBe(true);
  });

  describe('줌아웃 시 역 마커 숨김 (#509)', () => {
    function triggerZoom(
      node: {
        props: {
          onRegionChangeComplete?: (r: {
            latitudeDelta: number;
            longitudeDelta: number;
          }) => void;
        };
      },
      delta: number,
    ) {
      act(() => {
        node.props.onRegionChangeComplete?.({
          latitudeDelta: delta,
          longitudeDelta: delta,
        });
      });
    }

    it('초기 줌(0.05)에서는 모든 그룹 마커 표시', () => {
      const { getByTestId } = render(<StationMap {...baseProps} />);
      expect(getByTestId('marker-강남')).toBeTruthy();
      expect(getByTestId('marker-선릉')).toBeTruthy();
    });

    it('가로 모드/태블릿: longitudeDelta만 임계값 초과해도 줌아웃 판정', () => {
      const { getByTestId, queryByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          nearbyStations={[mockStation, anotherStation]}
        />,
      );
      // longitudeDelta가 임계값 초과지만 latitudeDelta는 임계값 이하
      act(() => {
        getByTestId('station-map').props.onRegionChangeComplete?.({
          latitudeDelta: 0.03,
          longitudeDelta: 0.2,
        });
      });
      expect(queryByTestId('marker-강남')).toBeNull();
    });

    it('줌아웃(latitudeDelta > 임계값) 시 일반 그룹 마커 숨김', () => {
      const { getByTestId, queryByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          nearbyStations={[mockStation, anotherStation]}
        />,
      );
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(queryByTestId('marker-강남')).toBeNull();
      expect(queryByTestId('marker-선릉')).toBeNull();
    });

    it('줌아웃 후 다시 줌인하면 마커 복원', () => {
      const { getByTestId, queryByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          nearbyStations={[mockStation, anotherStation]}
        />,
      );
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(queryByTestId('marker-강남')).toBeNull();
      triggerZoom(getByTestId('station-map'), 0.03);
      expect(getByTestId('marker-강남')).toBeTruthy();
      expect(getByTestId('marker-선릉')).toBeTruthy();
    });

    it('줌아웃 상태에서도 nearestStation 그룹은 유지', () => {
      const { getByTestId } = render(<StationMap {...baseProps} />);
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(getByTestId('marker-강남')).toBeTruthy();
    });

    it('줌아웃 상태에서도 customOriginId 그룹은 유지', () => {
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          customOriginId="2-023"
        />,
      );
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(getByTestId('marker-선릉')).toBeTruthy();
    });

    it('줌아웃 상태에서도 destinationId 그룹은 유지', () => {
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          destinationId="2-023"
        />,
      );
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(getByTestId('marker-선릉')).toBeTruthy();
    });

    it('줌아웃 상태에서도 경로 환승역 그룹은 유지', () => {
      const transferStation: Station = {
        id: '3-329',
        name: '교대',
        nameEn: "Seoul Nat'l Univ. of Education",
        line: '3',
        lineColor: '#EF7C1C',
        lat: 37.4933,
        lng: 127.0146,
      };
      const routeCoords = {
        path: [{ latitude: transferStation.lat, longitude: transferStation.lng }],
        keyStations: [{ station: transferStation, role: 'transfer' as const }],
      };
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearestStation={null}
          nearbyStations={[mockStation, anotherStation, transferStation]}
          routeCoords={routeCoords}
        />,
      );
      triggerZoom(getByTestId('station-map'), 0.2);
      expect(getByTestId('marker-교대')).toBeTruthy();
    });
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
      const { rerender } = render(<StationMap {...baseProps} recenterNonce={1} />);
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
      const { rerender } = render(<StationMap {...baseProps} recenterNonce={1} />);
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

    it('routeCoords 미전달 시 polyline / 점 오버레이가 없다', () => {
      const { queryByTestId } = render(<StationMap {...baseProps} />);
      expect(queryByTestId('route-polyline')).toBeNull();
      expect(queryByTestId(`route-marker-transfer-${transferStation.id}`)).toBeNull();
    });

    it('routeCoords 전달 시 polyline만 오버레이하고 모든 키 역은 베이스 마커에서 재사용', () => {
      const { getByTestId, queryByTestId } = render(
        <StationMap
          {...baseProps}
          nearbyStations={[mockStation, transferStation, destStation]}
          routeCoords={routeCoords}
        />,
      );
      expect(getByTestId('route-polyline')).toBeTruthy();
      expect(queryByTestId(`route-marker-transfer-${transferStation.id}`)).toBeNull();
      expect(queryByTestId(`route-marker-origin-${mockStation.id}`)).toBeNull();
      expect(queryByTestId(`route-marker-destination-${destStation.id}`)).toBeNull();
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
      render(<StationMap {...baseProps} routeCoords={{ path: [], keyStations: [] }} />);
      await waitFor(() => {
        expect(__animateToRegionMock).not.toHaveBeenCalled();
      });
      expect(__fitToCoordinatesMock).not.toHaveBeenCalled();
    });

    it('환승역 배지는 베이스 마커에서 accent 색으로 강조된다', () => {
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearbyStations={[mockStation, transferStation, destStation]}
          routeCoords={routeCoords}
        />,
      );
      const transferBadge = getByTestId(`badge-${transferStation.id}`);
      expect(transferBadge.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backgroundColor: '#C8553D' }),
        ]),
      );
    });

    it('환승역 그룹에서 route가 통과하는 호선의 배지만 accent로 강조', () => {
      // (역, 호선) 단위 강조: 같은 물리역의 다른 호선은 노선 색 유지.
      const transferOtherLine: Station = {
        id: '2-329',
        name: transferStation.name,
        nameEn: transferStation.nameEn,
        line: '2',
        lineColor: '#00A84D',
        lat: transferStation.lat,
        lng: transferStation.lng,
      };
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearbyStations={[mockStation, transferStation, transferOtherLine, destStation]}
          routeCoords={routeCoords}
        />,
      );
      const routedBadge = getByTestId(`badge-${transferStation.id}`);
      const otherBadge = getByTestId(`badge-${transferOtherLine.id}`);
      expect(routedBadge.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backgroundColor: '#C8553D' }),
        ]),
      );
      expect(otherBadge.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backgroundColor: transferOtherLine.lineColor }),
        ]),
      );
    });

    it('destinationId 전달 시 베이스 마커의 도착역 배지가 accent 색으로 강조', () => {
      const { getByTestId } = render(
        <StationMap
          {...baseProps}
          nearbyStations={[mockStation, destStation]}
          destinationId={destStation.id}
        />,
      );
      const destBadge = getByTestId(`badge-${destStation.id}`);
      expect(destBadge.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backgroundColor: '#C8553D' }),
        ]),
      );
    });
  });
});
