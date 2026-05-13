import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import stations from '../data/stations.json';
import type { Station } from '../types/station';
import { StationMap } from './StationMap';
import { StationSuggestionList } from './StationSuggestionList';
import { createLogger } from '../utils/logger';
import { matchesStationQuery } from '../utils/stationDisplay';
import { useTheme, spacing, radius } from '../theme';

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
  const { colors } = useTheme();
  const { t } = useTranslation();

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
    const qLower = q.toLowerCase();
    const result = allStations.filter((s) => matchesStationQuery(s, q, qLower)).slice(0, 8);
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
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
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
            <Text style={[styles.mapFallbackText, { color: colors.muted }]}>
              {t('destinationPicker.noLocation')}
            </Text>
          </View>
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          <View style={[styles.header, { backgroundColor: colors.bgTranslucent }]}>
            <Text style={[styles.title, { color: colors.ink }]}>{t('destinationPicker.title')}</Text>
            <TouchableOpacity onPress={handleClose} testID="close-button">
              <Text style={[styles.closeText, { color: colors.accent }]}>{t('common.close')}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={[styles.input, { backgroundColor: colors.card, color: colors.ink, borderColor: colors.hair }]}
            placeholder={t('destinationPicker.searchPlaceholder')}
            placeholderTextColor={colors.subtle}
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            testID="search-input"
          />
          {showDropdown && (
            <View style={styles.dropdownWrap}>
              <StationSuggestionList
                suggestions={suggestions}
                onSelect={handleSelect}
                listTestID="suggestions-list"
                itemTestIDPrefix="suggestion-item-"
              />
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
  },
  mapFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  mapFallbackText: {
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
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeText: {
    fontSize: 16,
  },
  input: {
    marginHorizontal: spacing.xl,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
    borderWidth: 1,
  },
  dropdownWrap: {
    marginHorizontal: spacing.xl,
    marginTop: 4,
  },
});
