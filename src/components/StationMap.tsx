import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import ClusteredMapView from 'react-native-map-clustering';
import { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import type MapView from 'react-native-maps';
import type { Station } from '../types/station';
import type { RouteCoordinatePath } from '../utils/routeToCoordinates';
import { buildMapConfig } from '../utils/buildMapConfig';
import { useTheme } from '../theme';
import { LINE_BADGE_LABEL } from '../constants/lineColors';
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
}

const FOCUS_REGION_DELTA = 0.01;
const FOCUS_ANIMATION_MS = 400;
const ROUTE_POLYLINE_WIDTH = 5;
const ROUTE_FIT_EDGE_PADDING = { top: 40, bottom: 40, left: 40, right: 40 };
const ROUTE_TRANSFER_MARKER_SIZE = 16;

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
}: StationMapProps) {
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const [mapReady, setMapReady] = useState(false);
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

  return (
    <View style={styles.map}>
      <ClusteredMapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{
          latitude: userLat,
          longitude: userLng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
        onMapReady={() => setMapReady(true)}
        showsUserLocation
        clusterColor={colors.accent}
        testID="station-map"
      >
        {mapConfig.groups.map((group) => {
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
        {/* 출발/도착역은 베이스 역 마커에서 customOriginId/destinationId로 강조 표시하므로
            같은 좌표에 마커를 중복 렌더해서 클러스터링되지 않도록 환승역만 오버레이. */}
        {routeCoords?.keyStations
          .filter(({ role }) => role === 'transfer')
          .map(({ station, role }) => (
            <Marker
              key={`route-${role}-${station.id}`}
              coordinate={{ latitude: station.lat, longitude: station.lng }}
              title={getStationDisplayName(station)}
              tracksViewChanges={false}
              anchor={{ x: 0.5, y: 0.5 }}
              testID={`route-marker-${role}-${station.id}`}
            >
              <View
                style={[
                  styles.routeMarkerDot,
                  {
                    width: ROUTE_TRANSFER_MARKER_SIZE,
                    height: ROUTE_TRANSFER_MARKER_SIZE,
                    borderRadius: ROUTE_TRANSFER_MARKER_SIZE / 2,
                    backgroundColor: station.lineColor,
                    borderColor: colors.bg,
                  },
                ]}
                testID={`route-marker-dot-${role}-${station.id}`}
              />
            </Marker>
          ))}
      </ClusteredMapView>
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
  routeMarkerDot: {
    borderWidth: 3,
  },
});

