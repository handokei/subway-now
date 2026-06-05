import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { router, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../../src/features/nearest-station/hooks/useNearestStation';
import { StationMap } from '../../src/features/map/components/StationMap';
import { MapSearchBar } from '../../src/features/map/components/MapSearchBar';
import { LocationStateView } from '../../src/components/LocationStateView';
import { StatusChip } from '../../src/features/arrival/components/StatusChip';
import stationsData from '../../src/data/stations.json';
import { useTheme, spacing, radius } from '../../src/shared/theme';
import { useAppStore } from '../../src/store/useAppStore';
import { LineBadge } from '../../src/components/LineBadge';
import { getStationDisplayName } from '../../src/features/nearest-station/utils/stationDisplay';
import { routeToCoordinates, type RouteCoordinatePath } from '../../src/features/route/utils/routeToCoordinates';
import type { Route } from '../../src/features/route/utils/stationRoute';
import { ROUTE_KEY } from '../../src/shared/constants/storageKeys';
import {
  FAVORITE_SLOT_ICONS,
  FAVORITE_SLOT_ROLES,
  type FavoriteSlotRole,
  type Station,
} from '../../src/shared/types/station';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh, accuracyMeters, locationUncertain } =
    useNearestStation();
  const allStations = stationsData as Station[];
  const { colors } = useTheme();
  const customOrigin = useAppStore((s) => s.customOrigin);
  const setCustomOrigin = useAppStore((s) => s.setCustomOrigin);
  const destination = useAppStore((s) => s.destination);
  const setDestination = useAppStore((s) => s.setDestination);
  const setRecentDestination = useAppStore((s) => s.setRecentDestination);
  const favorites = useAppStore((s) => s.favorites);
  const setSlotFavorite = useAppStore((s) => s.setSlotFavorite);
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [focusStation, setFocusStation] = useState<Station | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const [selectionCardHeight, setSelectionCardHeight] = useState(0);
  const [storedRoute, setStoredRoute] = useState<Route>(null);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // 홈 탭이 ROUTE_KEY에 저장한 경로를 화면 포커스 시 읽어 폴리라인 오버레이로 표시.
  // destination/customOrigin이 바뀌면 홈 탭이 ROUTE_KEY를 갱신하므로 deps에 포함해 재로딩.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      AsyncStorage.getItem(ROUTE_KEY)
        .then((raw) => {
          if (cancelled) return;
          if (!raw) {
            setStoredRoute(null);
            return;
          }
          try {
            setStoredRoute(JSON.parse(raw) as Route);
          } catch {
            setStoredRoute(null);
          }
        })
        .catch(() => {
          if (!cancelled) setStoredRoute(null);
        });
      return () => {
        cancelled = true;
      };
    }, [destination?.id, customOrigin?.id]),
  );

  const routeOrigin = customOrigin ?? result?.station ?? null;
  const routeCoords = useMemo<RouteCoordinatePath | null>(() => {
    if (!storedRoute || !routeOrigin || !destination) return null;
    return routeToCoordinates(storedRoute, routeOrigin, destination);
  }, [storedRoute, routeOrigin?.id, destination?.id]);

  if (permissionDenied || loading || !userLocation || error) {
    return (
      <LocationStateView
        permissionDenied={permissionDenied}
        loading={loading || !userLocation}
        error={error}
        onRetry={refresh}
      />
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]} edges={['top']}>
      {/* 상단 상태 배너 */}
      {(customOrigin || destination) && (
        <View style={[styles.statusBar, { backgroundColor: colors.card, borderBottomColor: colors.hair }]} testID="status-bar">
          {customOrigin && (
            <StatusChip label={t('map.originBadge')} name={getStationDisplayName(customOrigin)} onClear={() => setCustomOrigin(null)} testID="clear-origin" />
          )}
          {destination && (
            <StatusChip label={t('map.destinationBadge')} name={getStationDisplayName(destination)} onClear={() => setDestination(null)} testID="clear-destination" />
          )}
        </View>
      )}

      <MapSearchBar
        onSelect={(station) => {
          setFocusStation(station);
          setFocusNonce((n) => n + 1);
          setSelectedStation(station);
        }}
      />

      <StationMap
        userLat={userLocation!.lat}
        userLng={userLocation!.lng}
        nearestStation={result?.station ?? null}
        nearbyStations={allStations}
        customOriginId={customOrigin?.id}
        destinationId={destination?.id}
        onStationPress={(station) => setSelectedStation(station)}
        focusStation={focusStation}
        focusNonce={focusNonce}
        recenterNonce={recenterNonce}
        routeCoords={routeCoords}
        accuracyMeters={accuracyMeters}
        locationUncertain={locationUncertain}
      />

      <TouchableOpacity
        style={[
          styles.recenterButton,
          {
            backgroundColor: colors.card,
            borderColor: colors.hair,
            bottom: spacing.xl + (selectedStation ? selectionCardHeight : insets.bottom),
          },
        ]}
        onPress={() => {
          // 카메라 이동만으로는 stale userLocation에서 벗어날 수 없으므로 fresh GPS fix를 함께 요청.
          void refresh();
          setRecenterNonce((n) => n + 1);
        }}
        accessibilityLabel={t('map.recenter')}
        testID="recenter-button"
      >
        <Text style={[styles.recenterIcon, { color: colors.ink }]}>◎</Text>
      </TouchableOpacity>

      {/* 하단 역 선택 카드 */}
      {selectedStation && (
        <View
          style={[styles.selectionCard, { backgroundColor: colors.card, borderColor: colors.hair, paddingBottom: spacing.xl + insets.bottom }]}
          onLayout={(e) => setSelectionCardHeight(e.nativeEvent.layout.height)}
          testID="selection-card"
        >
          <View style={styles.selectionHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.selectionName, { color: colors.ink }]}>{getStationDisplayName(selectedStation)}</Text>
              <LineBadge line={selectedStation.line} />
            </View>
            <TouchableOpacity onPress={() => setSelectedStation(null)} testID="close-selection">
              <Text style={[styles.closeText, { color: colors.muted }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.selectionButtons}>
            <TouchableOpacity
              style={[styles.selectionButton, { backgroundColor: colors.accent }]}
              onPress={() => {
                setCustomOrigin(selectedStation);
                setSelectedStation(null);
              }}
              testID="set-origin-button"
            >
              <Text style={[styles.selectionButtonText, { color: colors.onAccent }]}>{t('map.setAsOrigin')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectionButton, { borderWidth: 1, borderColor: colors.accent }]}
              onPress={() => {
                setRecentDestination(selectedStation);
                setDestination(selectedStation);
                setSelectedStation(null);
                router.navigate('/(tabs)');
              }}
              testID="set-destination-button"
            >
              <Text style={[styles.selectionButtonText, { color: colors.accent }]}>{t('map.setAsDestination')}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.slotButtons}>
            {FAVORITE_SLOT_ROLES.map((role) => {
              const { station: slotStation } = favorites.find((f) => f.role === role) ?? {};
              const isCurrent = slotStation?.id === selectedStation.id;
              return (
                <TouchableOpacity
                  key={role}
                  style={[styles.slotButton, { borderColor: colors.hair, backgroundColor: isCurrent ? colors.accent : colors.bg }]}
                  onPress={() => {
                    if (isCurrent) return;
                    setSlotFavorite(role, selectedStation);
                  }}
                  disabled={isCurrent}
                  testID={`assign-slot-${role}`}
                >
                  <Text style={styles.slotButtonIcon}>{FAVORITE_SLOT_ICONS[role]}</Text>
                  <Text style={[styles.slotButtonText, { color: isCurrent ? colors.onAccent : colors.ink }]}>
                    {isCurrent ? t('map.slotAlreadyAssigned', { label: t(`favorites.${role}`) }) : t('map.assignAsSlot', { label: t(`favorites.${role}`) })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  statusBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    borderBottomWidth: 1,
  },
  closeText: {
    fontSize: 16,
    paddingHorizontal: spacing.xs,
  },
  selectionCard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  selectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  selectionName: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  selectionButtons: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  selectionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  selectionButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  slotButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  slotButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  slotButtonIcon: {
    fontSize: 14,
  },
  slotButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  recenterButton: {
    position: 'absolute',
    right: spacing.lg,
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  recenterIcon: {
    fontSize: 22,
    lineHeight: 24,
  },
});
