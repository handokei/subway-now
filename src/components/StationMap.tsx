import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import type { Station } from '../types/station';
import type { RouteCoordinatePath } from '../utils/routeToCoordinates';
import { buildMapConfig } from '../utils/buildMapConfig';
import { useTheme, withAlpha } from '../shared/theme';
import { LINE_BADGE_LABEL } from '../shared/constants/lineColors';
import { getStationDisplayName } from '../utils/stationDisplay';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  customOriginId?: string;
  /** 경로 도착역 id. 베이스 마커에서 accent 강조를 적용한다. */
  destinationId?: string;
  onStationPress?: (station: Station) => void;
  /** 검색 결과 선택 시 지도 카메라를 이동시킬 역. focusNonce가 변할 때마다 재이동한다. */
  focusStation?: Station | null;
  /** 같은 역을 다시 선택해도 카메라가 다시 움직이도록 매 선택마다 변경되는 값. */
  focusNonce?: number;
  /** 값이 변할 때마다 사용자 좌표(userLat/userLng)로 카메라를 다시 이동시킨다. */
  recenterNonce?: number;
  /** 선택된 경로의 폴리라인 좌표 + 강조 마커. 있으면 지도에 오버레이로 표시. */
  routeCoords?: RouteCoordinatePath | null;
  /** GPS 정확도 반경(m). 있으면 사용자 좌표 위에 신뢰도 원으로 표시. */
  accuracyMeters?: number | null;
  /** GPS 게이트 실패로 위치가 불확실한 상태. true면 원을 회색/투명도↓로 자백. */
  locationUncertain?: boolean;
}

// 도심 GPS 정확도 5~50m 구간에서 점으로 수렴하는 것을 막는 최소 반경.
// 50m로 키워 사용자가 정확도 원의 존재를 바로 인지할 수 있게 함.
const ACCURACY_MIN_RADIUS_M = 50;
// stroke 1px은 retina 디스플레이에서 거의 안 보여 2로 상향.
const ACCURACY_STROKE_WIDTH = 2;
// iOS 시스템 블루 — Apple Maps의 사용자 위치 파란 점과 자연스럽게 통일.
// 카카오/네이버 지도의 정확도 원도 동일 톤.
const ACCURACY_BLUE = '#007AFF';

const FOCUS_REGION_DELTA = 0.01;
const FOCUS_ANIMATION_MS = 400;
const ROUTE_POLYLINE_WIDTH = 5;
const ROUTE_FIT_EDGE_PADDING = { top: 40, bottom: 40, left: 40, right: 40 };
const INITIAL_LATITUDE_DELTA = 0.05;
// 줌 임계값(latitudeDelta 또는 longitudeDelta 중 큰 값 기준). 이 값보다 크면(줌아웃)
// 일반 역 마커 전부 숨기고 사용자 컨텍스트(nearest/origin/destination/route transfer)만 노출.
// 서울 위도(37.5°) 기준 latDelta 0.08 ≈ 가시 폭 약 8.8km.
const HIDE_MARKERS_REGION_DELTA = 0.08;

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  customOriginId,
  destinationId,
  onStationPress,
  focusStation,
  focusNonce,
  recenterNonce,
  routeCoords,
  accuracyMeters,
  locationUncertain = false,
}: StationMapProps) {
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const [mapReady, setMapReady] = useState(false);
  const [regionDelta, setRegionDelta] = useState(INITIAL_LATITUDE_DELTA);
  const mapRef = useRef<MapView | null>(null);
  // nonce 트리거 effect에서 stale closure 없이 항상 최신 좌표를 쓰기 위한 ref.
  const userPosRef = useRef({ lat: userLat, lng: userLng });
  userPosRef.current = { lat: userLat, lng: userLng };

  useEffect(() => {
    if (!focusStation) return;
    mapRef.current?.animateToRegion(
      {
        latitude: focusStation.lat,
        longitude: focusStation.lng,
        latitudeDelta: FOCUS_REGION_DELTA,
        longitudeDelta: FOCUS_REGION_DELTA,
      },
      FOCUS_ANIMATION_MS,
    );
  }, [focusStation?.id, focusNonce]);

  useEffect(() => {
    if (recenterNonce === undefined) return;
    mapRef.current?.animateToRegion(
      {
        latitude: userPosRef.current.lat,
        longitude: userPosRef.current.lng,
        latitudeDelta: FOCUS_REGION_DELTA,
        longitudeDelta: FOCUS_REGION_DELTA,
      },
      FOCUS_ANIMATION_MS,
    );
  }, [recenterNonce]);

  useEffect(() => {
    if (!mapReady || !routeCoords || routeCoords.path.length === 0) return;
    mapRef.current?.fitToCoordinates(routeCoords.path, {
      edgePadding: ROUTE_FIT_EDGE_PADDING,
      animated: true,
    });
  }, [mapReady, routeCoords]);

  const mapConfig = useMemo(
    () => buildMapConfig({ userLat, userLng, nearestStation, nearbyStations }),
    [userLat, userLng, nearestStation?.id, nearbyStations],
  );

  // 경로상 환승역 id 집합. 베이스 마커에서 출발/도착과 동일하게 accent 강조한다.
  const routeTransferIds = useMemo(() => {
    const ids = new Set<string>();
    routeCoords?.keyStations.forEach(({ station, role }) => {
      if (role === 'transfer') ids.add(station.id);
    });
    return ids;
  }, [routeCoords]);

  // 줌아웃 상태에서는 사용자 컨텍스트 그룹만 노출 (네이버 지도 스타일).
  // 평상시 줌에서는 전체 그룹 표시.
  const isZoomedOut = regionDelta > HIDE_MARKERS_REGION_DELTA;
  const visibleGroups = useMemo(() => {
    if (!isZoomedOut) return mapConfig.groups;
    return mapConfig.groups.filter((group) => {
      if (group.isNearest) return true;
      return group.stations.some(
        (s) =>
          s.id === customOriginId ||
          s.id === destinationId ||
          routeTransferIds.has(s.id),
      );
    });
  }, [isZoomedOut, mapConfig.groups, customOriginId, destinationId, routeTransferIds]);

  return (
    <View style={styles.map}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{
          latitude: userLat,
          longitude: userLng,
          latitudeDelta: INITIAL_LATITUDE_DELTA,
          longitudeDelta: INITIAL_LATITUDE_DELTA,
        }}
        onMapReady={() => setMapReady(true)}
        onRegionChangeComplete={(region) =>
          setRegionDelta(Math.max(region.latitudeDelta, region.longitudeDelta))
        }
        showsUserLocation
        showsPointsOfInterest={Platform.OS === 'ios' ? false : undefined}
        testID="station-map"
      >
        {/* 정확도 원을 마커보다 먼저 렌더 — 큰 반경에서 마커 탭 인식을 가리지 않도록.
            accuracyMeters는 useNearestStation에서 마지막 정상 fix 기준 값을 유지하므로
            locationUncertain일 때도 직전 반경을 muted 색으로 표시해 자백 효과를 낸다. */}
        {accuracyMeters != null && accuracyMeters > 0 && (
          <Circle
            center={{ latitude: userLat, longitude: userLng }}
            radius={Math.max(accuracyMeters, ACCURACY_MIN_RADIUS_M)}
            strokeColor={
              locationUncertain ? colors.muted : withAlpha(ACCURACY_BLUE, 0.6)
            }
            strokeWidth={ACCURACY_STROKE_WIDTH}
            fillColor={withAlpha(
              locationUncertain ? colors.muted : ACCURACY_BLUE,
              locationUncertain ? 0.1 : 0.15,
            )}
            testID="accuracy-circle"
          />
        )}
        {visibleGroups.map((group) => {
          // 대표 station = representativeName과 동일한 name을 가진 멤버.
          // representativeName은 멤버 중에서 뽑은 값이므로 find는 항상 매치.
          const representative = group.stations.find(
            (s) => s.name === group.representativeName,
          ) as typeof group.stations[number];
          const label = getStationDisplayName(representative);
          return (
            <Marker
              key={`${group.key}-${i18n.language}`}
              coordinate={{ latitude: group.lat, longitude: group.lng }}
              title={label}
              onPress={() => onStationPress?.(representative)}
              tracksViewChanges={false}
              testID={`marker-${group.key}`}
            >
              <View style={styles.markerContainer}>
                <View style={styles.badgeRow} testID={`badge-row-${group.key}`}>
                  {group.stations.map((s) => {
                    // 배지별 강조: 환승역 그룹에서도 실제 매칭된 호선만 accent.
                    // customOriginId/nearestStation은 (역, 호선) 단위 식별자라 멤버 단위로 비교.
                    const isThisBadgeHighlighted =
                      s.id === customOriginId ||
                      s.id === destinationId ||
                      routeTransferIds.has(s.id) ||
                      (group.isNearest && nearestStation?.id === s.id);
                    return (
                      <View
                        key={s.id}
                        style={[
                          styles.badge,
                          {
                            backgroundColor: isThisBadgeHighlighted
                              ? colors.accent
                              : s.lineColor,
                          },
                        ]}
                        testID={`badge-${s.id}`}
                      >
                        <Text style={styles.badgeText} numberOfLines={1}>
                          {LINE_BADGE_LABEL[s.line]}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <View
                  style={styles.markerLabelPill}
                  testID={`label-pill-${group.key}`}
                >
                  <Text style={styles.markerLabel} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              </View>
            </Marker>
          );
        })}
        {routeCoords && routeCoords.path.length > 0 && (
          <Polyline
            coordinates={routeCoords.path}
            strokeColor={colors.accent}
            strokeWidth={ROUTE_POLYLINE_WIDTH}
            testID="route-polyline"
          />
        )}
      </MapView>
      {!mapReady && (
        <View style={styles.loading} testID="map-loading">
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerContainer: {
    alignItems: 'center',
    maxWidth: 120,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 2,
  },
  badge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
  markerLabelPill: {
    marginTop: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  markerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111111',
    textAlign: 'center',
  },
});

