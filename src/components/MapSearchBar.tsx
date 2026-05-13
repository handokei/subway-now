import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import { LINE_NAMES } from '../constants/lineColors';
import { getStationDisplayName, matchesStationQuery } from '../utils/stationDisplay';
import { useTheme, spacing, radius } from '../theme';

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
    return allStations
      .filter((s) => matchesStationQuery(s, q, qLower))
      .slice(0, MAX_SUGGESTIONS);
  }, [query]);

  function handleSelect(station: Station) {
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
      {showDropdown && suggestions.length > 0 && (
        <View
          style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.hair }]}
          testID="map-search-suggestions"
        >
          {suggestions.map((s) => (
            <TouchableOpacity
              key={s.id}
              style={[styles.suggestionItem, { borderBottomColor: colors.hair }]}
              onPress={() => handleSelect(s)}
              testID={`map-search-suggestion-${s.id}`}
            >
              <Text style={[styles.suggestionName, { color: colors.ink }]}>
                {getStationDisplayName(s)}
              </Text>
              <View style={[styles.lineBadge, { backgroundColor: s.lineColor }]}>
                <Text style={styles.lineText}>{LINE_NAMES[s.line]}</Text>
              </View>
            </TouchableOpacity>
          ))}
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
  dropdown: {
    marginTop: 4,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
  },
  suggestionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  suggestionName: {
    fontSize: 15,
  },
  lineBadge: {
    borderRadius: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  lineText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
});
