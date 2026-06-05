/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import stations from '../../../data/stations.json';
import {
  FAVORITE_SLOT_ICONS,
  FAVORITE_SLOT_ROLES,
  isFavoriteSlotRole,
  type FavoriteEntry,
  type FavoriteSlotRole,
  type Station,
} from '../../../shared/types/station';
import { StationMap } from '../../map/components/StationMap';
import { StationSuggestionList } from '../../nearest-station/components/StationSuggestionList';
import { createLogger } from '../../../shared/utils/logger';
import { matchesStationQuery, getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { useTheme, spacing, radius } from '../../../shared/theme';

const logger = createLogger('DestinationPicker');


const allStations = stations as Station[];

interface Props {
  readonly visible: boolean;
  readonly onSelect: (station: Station) => void;
  readonly onClose: () => void;
  readonly favorites?: readonly FavoriteEntry[];
  readonly userLat?: number | null;
  readonly userLng?: number | null;
  readonly onRecenter?: () => void;
  readonly onAssignSlot?: (role: FavoriteSlotRole, station: Station) => void;
}

export function DestinationPicker({
  visible,
  onSelect,
  onClose,
  userLat,
  userLng,
  favorites,
  onRecenter,
  onAssignSlot,
}: Props) {
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const [pendingSlot, setPendingSlot] = useState<FavoriteSlotRole | null>(null);
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

  // 즐겨찾기 chip — 항상 노출. trip 종료 후에도 다시 누를 수 있어야 한다 (#555).
  // home → work → general 순으로 정렬. home/work는 아이콘+라벨로 표시 (#557).
  const favoriteChips = useMemo(() => {
    if (!favorites || favorites.length === 0) return [];
    const order: Record<string, number> = { home: 0, work: 1, general: 2 };
    return [...favorites].sort((a, b) => order[a.role] - order[b.role]);
  }, [favorites]);

  // #559: 미설정 슬롯에 placeholder chip 노출 — 누르면 다음 선택 역을 슬롯에 저장하는 모드 진입.
  const unassignedSlotRoles = useMemo(() => {
    if (!onAssignSlot) return [];
    const assigned = new Set((favorites ?? []).map((f) => f.role));
    return FAVORITE_SLOT_ROLES.filter((role) => !assigned.has(role));
  }, [favorites, onAssignSlot]);

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
    if (pendingSlot && onAssignSlot) {
      onAssignSlot(pendingSlot, station);
      setPendingSlot(null);
      return;
    }
    onSelect(station);
  }

  function handleClose() {
    setQuery('');
    setShowDropdown(false);
    setPendingSlot(null);
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
            recenterNonce={recenterNonce}
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
          {pendingSlot && (
            <View style={[styles.pendingBanner, { backgroundColor: colors.accent }]} testID="pending-slot-banner">
              <Text style={[styles.pendingText, { color: colors.onAccent }]}>
                {t('destinationPicker.pendingSlot', { label: t(`favorites.${pendingSlot}`) })}
              </Text>
              <TouchableOpacity onPress={() => setPendingSlot(null)} testID="pending-slot-cancel">
                <Text style={[styles.pendingCancel, { color: colors.onAccent }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </View>
          )}
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
          {(favoriteChips.length > 0 || unassignedSlotRoles.length > 0) && !showDropdown && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.chipScroll}
              contentContainerStyle={styles.chipRow}
              testID="favorites-chip-row"
            >
              {unassignedSlotRoles.map((role) => (
                <TouchableOpacity
                  key={`slot-placeholder-${role}`}
                  style={[
                    styles.chip,
                    styles.chipPlaceholder,
                    {
                      backgroundColor: colors.card,
                      borderColor: pendingSlot === role ? colors.accent : colors.hair,
                    },
                  ]}
                  onPress={() => setPendingSlot(pendingSlot === role ? null : role)}
                  testID={`slot-placeholder-chip-${role}`}
                >
                  <Text style={styles.chipIcon}>{FAVORITE_SLOT_ICONS[role]}</Text>
                  <Text style={[styles.chipText, { color: colors.ink }]}>
                    {t('destinationPicker.assignSlot', { label: t(`favorites.${role}`) })}
                  </Text>
                </TouchableOpacity>
              ))}
              {favoriteChips.map(({ station, role, label }) => {
                const isSlot = isFavoriteSlotRole(role);
                const chipText = isSlot
                  ? t(`favorites.${role}`)
                  : label ?? getStationDisplayName(station);
                return (
                  <TouchableOpacity
                    key={station.id}
                    style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.hair }]}
                    onPress={() => handleSelect(station)}
                    testID={`favorite-chip-${station.id}`}
                  >
                    {isSlot && <Text style={styles.chipIcon}>{FAVORITE_SLOT_ICONS[role]}</Text>}
                    <Text style={[styles.chipText, { color: colors.ink }]}>{chipText}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
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

        {mapAvailable && (
          <TouchableOpacity
            style={[
              styles.recenterButton,
              { backgroundColor: colors.card, borderColor: colors.hair },
            ]}
            onPress={() => {
              onRecenter?.();
              setRecenterNonce((n) => n + 1);
            }}
            accessibilityLabel={t('map.recenter')}
            testID="recenter-button"
          >
            <Text style={[styles.recenterIcon, { color: colors.ink }]}>◎</Text>
          </TouchableOpacity>
        )}
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
  chipScroll: {
    marginTop: spacing.sm,
  },
  chipRow: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    gap: 6,
  },
  chipIcon: {
    fontSize: 14,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  chipPlaceholder: {
    borderStyle: 'dashed',
  },
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.xl,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  pendingText: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  pendingCancel: {
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
  },
  recenterButton: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.xl,
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
