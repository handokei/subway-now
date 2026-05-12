import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import ClusteredMapView from 'react-native-map-clustering';
import { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import type { Station } from '../types/station';
import type { TrainMarker as TrainMarkerData } from '../utils/findTrainCoordinates';
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
}

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  customOriginId,
  onStationPress,
  trainMarkers,
}: StationMapProps) {
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const [mapReady, setMapReady] = useState(false);

  const mapConfig = useMemo(
    () => buildMapConfig({ userLat, userLng, nearestStation, nearbyStations }),
    [userLat, userLng, nearestStation?.id, nearbyStations],
  );

  return (
    <View style={styles.map}>
      <ClusteredMapView
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
                  style={[
                    styles.markerDot,
                    { backgroundColor: dotColor, borderColor: colors.card },
                  ]}
                  testID={`dot-${station.id}`}
                />
                <Text
                  style={[styles.markerLabel, { color: colors.ink }]}
                  numberOfLines={1}
                >
                  {getStationDisplayName(station)}
                </Text>
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
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
  },
  markerLabel: {
    fontSize: 9,
    fontWeight: '600',
    marginTop: 2,
    textAlign: 'center',
  },
  trainMarker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
  },
});

