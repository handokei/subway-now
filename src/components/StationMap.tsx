import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import ClusteredMapView from 'react-native-map-clustering';
import { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import type MapView from 'react-native-maps';
import type { Station } from '../types/station';
import type { TrainMarker as TrainMarkerData } from '../utils/findTrainCoordinates';
import type { RouteCoordinatePath, RouteStationRole } from '../utils/routeToCoordinates';
import { buildMapConfig } from '../utils/buildMapConfig';
import { useTheme } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';
import { getStationDisplayName } from '../utils/stationDisplay';
import { TRAIN_STATUS } from '../constants/trainStatus';

/** trainSttus → i18n 키. 데이터 주도 — 새 status 추가 시 한 줄. */
type StatusKey =
  | 'map.train.status.arrived'
  | 'map.train.status.entering'
  | 'map.train.status.departed'
  | 'map.train.status.prevDeparted'
  | 'map.train.status.running';
const TRAIN_STATUS_I18N_KEY: Record<number, StatusKey> = {
  [TRAIN_STATUS.ARRIVED]: 'map.train.status.arrived',
  [TRAIN_STATUS.ENTERING]: 'map.train.status.entering',
  [TRAIN_STATUS.DEPARTED]: 'map.train.status.departed',
  [TRAIN_STATUS.PREV_DEPARTED]: 'map.train.status.prevDeparted',
};
const TRAIN_STATUS_FALLBACK_KEY: StatusKey = 'map.train.status.running';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  customOriginId?: string;
  onStationPress?: (station: Station) => void;
  /** Phase 3 Stage 3: 활성 호선의 실시간 열차 위치. 없으면 표시 안 함. */
  trainMarkers?: TrainMarkerData[];
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
const ROUTE_MARKER_SIZE: Record<RouteStationRole, number> = {
  origin: 18,
  transfer: 16,
  destination: 18,
};

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  customOriginId,
  onStationPress,
  trainMarkers,
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
        {mapConfig.stations.map((station) => {
          const isHighlighted = station.id === customOriginId || station.isNearest;
          const dotColor = isHighlighted ? colors.accent : station.lineColor;
          return (
            <Marker
              key={`${station.id}-${i18n.language}`}
              coordinate={{ latitude: station.lat, longitude: station.lng }}
              title={getStationDisplayName(station)}
              description={LINE_NAMES[station.line]}
              onPress={() => onStationPress?.(station)}
              tracksViewChanges={false}
              testID={`marker-${station.id}`}
            >
              <View style={styles.markerContainer}>
                <View
                  style={[styles.markerDot, { backgroundColor: dotColor }]}
                  testID={`dot-${station.id}`}
                />
                <View
                  style={styles.markerLabelPill}
                  testID={`label-pill-${station.id}`}
                >
                  <Text style={styles.markerLabel} numberOfLines={1}>
                    {getStationDisplayName(station)}
                  </Text>
                </View>
              </View>
            </Marker>
          );
        })}
        {trainMarkers?.map((tm) => {
          // 같은 역에 여러 트레인이 있을 수 있어 trainNo로 키 unique
          const isArrived = tm.trainStatus === TRAIN_STATUS.ARRIVED;
          const isEntering = tm.trainStatus === TRAIN_STATUS.ENTERING;
          // 도착 = 강조(채워짐), 진입 = 외곽선만, 그외 = 흐림
          const opacity = isArrived ? 1 : isEntering ? 0.85 : 0.5;
          const statusKey = TRAIN_STATUS_I18N_KEY[tm.trainStatus] ?? TRAIN_STATUS_FALLBACK_KEY;
          return (
            <Marker
              key={`train-${tm.line}-${tm.trainNo}`}
              coordinate={{ latitude: tm.lat, longitude: tm.lng }}
              title={t('map.train.terminalSuffix', { name: tm.terminalStationName })}
              description={t('map.train.descriptionTemplate', {
                trainNo: tm.trainNo,
                status: t(statusKey),
              })}
              tracksViewChanges={false}
              testID={`train-marker-${tm.trainNo}`}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View
                style={[
                  styles.trainMarker,
                  {
                    backgroundColor: isArrived ? tm.lineColor : 'transparent',
                    borderColor: tm.lineColor,
                    opacity,
                  },
                ]}
                testID={`train-dot-${tm.trainNo}`}
              />
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
        {routeCoords?.keyStations.map(({ station, role }) => {
          const size = ROUTE_MARKER_SIZE[role];
          const bg = role === 'transfer' ? station.lineColor : colors.accent;
          return (
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
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: bg,
                    borderColor: colors.bg,
                  },
                ]}
                testID={`route-marker-dot-${role}-${station.id}`}
              />
            </Marker>
          );
        })}
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
    maxWidth: 60,
  },
  markerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#ffffff',
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
  trainMarker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
  },
  routeMarkerDot: {
    borderWidth: 3,
  },
});

