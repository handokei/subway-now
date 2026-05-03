import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { StationMap } from '../../src/components/StationMap';
import { LocationStateView } from '../../src/components/LocationStateView';
import { StatusChip } from '../../src/components/StatusChip';
import stationsData from '../../src/data/stations.json';
import { useTheme, spacing, radius } from '../../src/theme';
import { useAppStore } from '../../src/store/useAppStore';
import { LineBadge } from '../../src/components/LineBadge';
import type { Station } from '../../src/types/station';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh } =
    useNearestStation();
  const allStations = stationsData as Station[];
  const { colors } = useTheme();
  const customOrigin = useAppStore((s) => s.customOrigin);
  const setCustomOrigin = useAppStore((s) => s.setCustomOrigin);
  const destination = useAppStore((s) => s.destination);
  const setDestination = useAppStore((s) => s.setDestination);
  const setRecentDestination = useAppStore((s) => s.setRecentDestination);
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const insets = useSafeAreaInsets();

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
            <StatusChip label="출발" name={customOrigin.name} onClear={() => setCustomOrigin(null)} testID="clear-origin" />
          )}
          {destination && (
            <StatusChip label="도착" name={destination.name} onClear={() => setDestination(null)} testID="clear-destination" />
          )}
        </View>
      )}

      <StationMap
        userLat={userLocation!.lat}
        userLng={userLocation!.lng}
        nearestStation={result?.station ?? null}
        nearbyStations={allStations}
        customOriginId={customOrigin?.id}
        onStationPress={(station) => setSelectedStation(station)}
      />

      {/* 하단 역 선택 카드 */}
      {selectedStation && (
        <View style={[styles.selectionCard, { backgroundColor: colors.card, borderColor: colors.hair, paddingBottom: spacing.xl + insets.bottom }]} testID="selection-card">
          <View style={styles.selectionHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.selectionName, { color: colors.ink }]}>{selectedStation.name}</Text>
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
              <Text style={[styles.selectionButtonText, { color: colors.onAccent }]}>출발역으로 설정</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectionButton, { borderWidth: 1, borderColor: colors.accent }]}
              onPress={() => {
                setRecentDestination(selectedStation);
                setDestination(selectedStation);
                setSelectedStation(null);
              }}
              testID="set-destination-button"
            >
              <Text style={[styles.selectionButtonText, { color: colors.accent }]}>도착역으로 설정</Text>
            </TouchableOpacity>
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
});
