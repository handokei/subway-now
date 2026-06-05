/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import React, { useMemo, useState } from 'react';
import { Keyboard, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import stationsData from '../../../data/stations.json';
import type { Station } from '../../../shared/types/station';
import { matchesStationQuery } from '../../../shared/utils/stationDisplay';
import { useTheme, spacing, radius } from '../../../shared/theme';
import { StationSuggestionList } from '../../nearest-station/components/StationSuggestionList';

const allStations = stationsData as Station[];
const MAX_SUGGESTIONS = 8;

interface Props {
  readonly onSelect: (station: Station) => void;
}

export function MapSearchBar({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const { colors } = useTheme();
  const { t } = useTranslation();

  const suggestions = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    return allStations.filter((s) => matchesStationQuery(s, q, qLower)).slice(0, MAX_SUGGESTIONS);
  }, [query]);

  function handleSelect(station: Station) {
    Keyboard.dismiss();
    setQuery('');
    setShowDropdown(false);
    onSelect(station);
  }

  return (
    <View style={styles.container} testID="map-search-bar">
      <TextInput
        style={[
          styles.input,
          { backgroundColor: colors.card, color: colors.ink, borderColor: colors.hair },
        ]}
        placeholder={t('map.search.placeholder')}
        placeholderTextColor={colors.subtle}
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        testID="map-search-input"
      />
      {showDropdown && (
        <View style={styles.dropdownWrap}>
          <StationSuggestionList
            suggestions={suggestions}
            onSelect={handleSelect}
            listTestID="map-search-suggestions"
            itemTestIDPrefix="map-search-suggestion-"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  input: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
    borderWidth: 1,
  },
  dropdownWrap: {
    marginTop: 4,
  },
});
