import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Station } from '../types/station';
import { LINE_NAMES } from '../constants/lineColors';
import { getStationDisplayName } from '../utils/stationDisplay';
import { useTheme, spacing, radius } from '../theme';

interface Props {
  readonly suggestions: readonly Station[];
  readonly onSelect: (station: Station) => void;
  readonly listTestID: string;
  readonly itemTestIDPrefix: string;
}

export function StationSuggestionList({ suggestions, onSelect, listTestID, itemTestIDPrefix }: Props) {
  const { colors } = useTheme();
  if (suggestions.length === 0) return null;
  return (
    <View
      style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.hair }]}
      testID={listTestID}
    >
      {suggestions.map((s) => (
        <TouchableOpacity
          key={s.id}
          style={[styles.item, { borderBottomColor: colors.hair }]}
          onPress={() => onSelect(s)}
          testID={`${itemTestIDPrefix}${s.id}`}
        >
          <Text style={[styles.name, { color: colors.ink }]}>{getStationDisplayName(s)}</Text>
          <View style={[styles.lineBadge, { backgroundColor: s.lineColor }]}>
            <Text style={styles.lineText}>{LINE_NAMES[s.line]}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dropdown: {
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
  },
  item: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  name: {
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
