import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import stations from '../data/stations.json';
import type { Station } from '../types/station';
import { LINE_NAMES } from '../constants/lineColors';
import { StationMap } from './StationMap';
import { createLogger } from '../utils/logger';
import { colors, spacing, radius } from '../theme';

const logger = createLogger('DestinationPicker');


const allStations = stations as Station[];

interface Props {
  readonly visible: boolean;
  readonly onSelect: (station: Station) => void;
  readonly onClose: () => void;
  readonly recentDestination?: Station | null;
  readonly userLat?: number | null;
  readonly userLng?: number | null;
}

export function DestinationPicker({
  visible,
  onSelect,
  onClose,
  userLat,
  userLng,
  recentDestination,
}: Props) {
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const openTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      openTimeRef.current = performance.now();
    } else if (openTimeRef.current !== null) {
      const duration = performance.now() - openTimeRef.current;
      logger.debug(`모달 세션 유지 시간: ${duration.toFixed(2)}ms`);
      openTimeRef.current = null;
    }
  }, [visible]);

  const mapAvailable = !!(userLat && userLng);

  const mapStations = useMemo(() => {
    if (!userLat || !userLng) return [];
    return allStations;
  }, [userLat, userLng]);

  const suggestions = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const start = performance.now();
    const result = allStations.filter((s) => s.name.includes(q)).slice(0, 8);
    logger.debug(`검색 필터링 "${q}": ${(performance.now() - start).toFixed(2)}ms (${result.length}건)`);
    return result;
  }, [query]);

  function handleSelect(station: Station) {
    setQuery('');
    setShowDropdown(false);
    onSelect(station);
  }

  function handleClose() {
    setQuery('');
    setShowDropdown(false);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        {mapAvailable && userLat && userLng ? (
          <StationMap
            userLat={userLat}
            userLng={userLng}
            nearestStation={null}
            nearbyStations={mapStations}
            onStationPress={handleSelect}
          />
        ) : (
          <View style={styles.mapFallback} testID="map-fallback">
            <Text style={styles.mapFallbackText}>
              위치 정보가 없습니다.
            </Text>
          </View>
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.header}>
            <Text style={styles.title}>목적지 설정</Text>
            <TouchableOpacity onPress={handleClose} testID="close-button">
              <Text style={styles.closeText}>닫기</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            placeholder="역 이름 검색"
            placeholderTextColor={colors.subtle}
            value={query}
            onChangeText={(t) => {
              setQuery(t);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            testID="search-input"
          />
          {showDropdown && suggestions.length > 0 && (
            <View style={styles.dropdown} testID="suggestions-list">
              {suggestions.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.suggestionItem}
                  onPress={() => handleSelect(s)}
                  testID={`suggestion-item-${s.id}`}
                >
                  <Text style={styles.suggestionName}>{s.name}</Text>
                  <View style={[styles.lineBadge, { backgroundColor: s.lineColor }]}>
                    <Text style={styles.lineText}>{LINE_NAMES[s.line]}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  mapFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  mapFallbackText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: 50,
    paddingBottom: spacing.md,
    backgroundColor: 'rgba(245, 242, 236, 0.92)',
  },
  title: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeText: {
    color: colors.accent,
    fontSize: 16,
  },
  input: {
    backgroundColor: colors.card,
    color: colors.ink,
    marginHorizontal: spacing.xl,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.hair,
  },
  dropdown: {
    backgroundColor: colors.card,
    marginHorizontal: spacing.xl,
    marginTop: 4,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.hair,
  },
  suggestionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.hair,
  },
  suggestionName: {
    color: colors.ink,
    fontSize: 15,
  },
  lineBadge: {
    borderRadius: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  lineText: {
    color: colors.onAccent, // 노선색 배경 위 텍스트
    fontSize: 12,
    fontWeight: 'bold',
  },
});
