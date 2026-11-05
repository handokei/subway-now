/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Station } from '../../../shared/types/station';
import { haversine } from '../../../shared/utils/haversine';
import { LINE_BADGE_LABEL } from '../../../shared/constants/lineColors';
import { groupStationsByName } from '../../nearest-station/utils/groupStationsByName';
import { useTheme, typography } from '../../../shared/theme';
import type { RouteCoordinatePath, RouteStationRole } from '../../route/utils/routeToCoordinates';

const ROLE_LABEL_KEY = {
  origin: 'map.originBadge',
  transfer: 'map.transferBadge',
  destination: 'map.destinationBadge',
} as const satisfies Record<RouteStationRole, string>;

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  // 네이티브 StationMap과 props 인터페이스 호환을 위해 선언만 미러한다.
  // web fallback은 리스트 UI라 정확도 원/uncertain 시각 변경 없음.
  accuracyMeters?: number | null;
  locationUncertain?: boolean;
  // 웹 fallback은 지도가 없어 폴리라인 대신 경로의 출발/환승/도착 키 역을 순서대로 나열한다.
  routeCoords?: RouteCoordinatePath | null;
}

function RouteSection({ routeCoords }: { routeCoords?: RouteCoordinatePath | null }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (!routeCoords || routeCoords.path.length === 0) return null;
  return (
    <View testID="route-section" style={[styles.routeSection, { backgroundColor: colors.card }]}>
      <Text style={[styles.header, { color: colors.muted }]}>{t('map.routeHeader')}</Text>
      {routeCoords.keyStations.map(({ station, role }, idx) => (
        <View
          key={`${station.id}-${role}-${idx}`}
          style={styles.routeRow}
          testID={`route-station-${idx}-${role}`}
        >
          <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
            <Text style={styles.badgeText}>{LINE_BADGE_LABEL[station.line]}</Text>
          </View>
          <Text style={[styles.name, { color: colors.ink }]}>{station.name}</Text>
          <Text style={[styles.distance, { color: colors.accent }]}>{t(ROLE_LABEL_KEY[role])}</Text>
        </View>
      ))}
    </View>
  );
}

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  routeCoords,
}: StationMapProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (nearbyStations.length === 0) {
    return (
      <View style={[styles.fallback, { backgroundColor: colors.bg }]}>
        <RouteSection routeCoords={routeCoords} />
        <Text style={[styles.emptyText, { color: colors.muted }]}>{t('map.noNearbyStations')}</Text>
      </View>
    );
  }

  const groups = groupStationsByName(nearbyStations);
  const sorted = groups
    .map((g) => ({
      group: g,
      distanceM: Math.round(haversine(userLat, userLng, g.lat, g.lng) * 1000),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={styles.content}>
      <RouteSection routeCoords={routeCoords} />
      <Text style={[styles.header, { color: colors.muted }]}>{t('map.nearbyStationsHeader')}</Text>
      {sorted.map(({ group, distanceM }) => {
        const isNearest = nearestStation
          ? group.stations.some((s) => s.id === nearestStation.id)
          : false;
        return (
          <View
            key={group.key}
            style={[
              styles.row,
              { backgroundColor: colors.card },
              isNearest && { borderWidth: 1, borderColor: colors.accent },
            ]}
            testID={`group-row-${group.key}`}
          >
            <View style={styles.badgeRow}>
              {group.stations.map((s) => (
                <View
                  key={s.id}
                  style={[styles.badge, { backgroundColor: s.lineColor }]}
                  testID={`badge-${s.id}`}
                >
                  <Text style={styles.badgeText}>{LINE_BADGE_LABEL[s.line]}</Text>
                </View>
              ))}
            </View>
            <Text style={[styles.name, { color: isNearest ? colors.accent : colors.ink }]}>
              {group.representativeName}
            </Text>
            <Text style={[styles.distance, { color: colors.muted }]}>{distanceM}m</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    ...typography.bodySm,
    textAlign: 'center',
  },
  routeSection: {
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    alignSelf: 'stretch',
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  header: {
    ...typography.captionSm,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    gap: 10,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 4,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    ...typography.micro,
    fontWeight: '700',
    color: '#ffffff',
  },
  name: {
    flex: 1,
    ...typography.bodyMd,
    fontWeight: '600',
  },
  distance: {
    ...typography.caption,
  },
});
