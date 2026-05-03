import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useMapData } from '../../src/hooks/useMapData';
import { StationMap } from '../../src/components/StationMap';
import { useTheme, spacing, radius } from '../../src/theme';
import { useAppStore } from '../../src/store/useAppStore';
import { LineBadge } from '../../src/components/LineBadge';
import type { Station } from '../../src/types/station';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh } =
    useNearestStation();
  const { nearbyStations } = useMapData(
    userLocation?.lat ?? null,
    userLocation?.lng ?? null
  );
  const { colors } = useTheme();
  const customOrigin = useAppStore((s) => s.customOrigin);
  const setCustomOrigin = useAppStore((s) => s.setCustomOrigin);
  const destination = useAppStore((s) => s.destination);
  const setDestination = useAppStore((s) => s.setDestination);
  const setRecentDestination = useAppStore((s) => s.setRecentDestination);
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const insets = useSafeAreaInsets();

  if (permissionDenied) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>위치 권한이 필요합니다.</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>권한 요청</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading || !userLocation) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>위치 확인 중...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>{error}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]} edges={['top']}>
      {/* 상단 상태 배너 */}
      {(customOrigin || destination) && (
        <View style={[styles.statusBar, { backgroundColor: colors.card, borderBottomColor: colors.hair }]} testID="status-bar">
          {customOrigin && (
            <View style={styles.statusChip}>
              <Text style={[styles.statusLabel, { color: colors.accent }]}>출발</Text>
              <Text style={[styles.statusName, { color: colors.ink }]} numberOfLines={1}>{customOrigin.name}</Text>
              <TouchableOpacity onPress={() => setCustomOrigin(null)} testID="clear-origin">
                <Text style={[styles.statusClose, { color: colors.muted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          {destination && (
            <View style={styles.statusChip}>
              <Text style={[styles.statusLabel, { color: colors.accent }]}>도착</Text>
              <Text style={[styles.statusName, { color: colors.ink }]} numberOfLines={1}>{destination.name}</Text>
              <TouchableOpacity onPress={() => setDestination(null)} testID="clear-destination">
                <Text style={[styles.statusClose, { color: colors.muted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      <StationMap
        userLat={userLocation.lat}
        userLng={userLocation.lng}
        nearestStation={result?.station ?? null}
        nearbyStations={nearbyStations}
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
              <Text style={[styles.statusClose, { color: colors.muted }]}>✕</Text>
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 16,
  },
  statusBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    borderBottomWidth: 1,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusName: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  statusClose: {
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
