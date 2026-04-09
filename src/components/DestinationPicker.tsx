import React, { useState, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import stations from '../data/stations.json';
import type { Station } from '../types/station';

const allStations = stations as Station[];

interface Props {
  visible: boolean;
  onSelect: (station: Station) => void;
  onClose: () => void;
  recentDestination?: Station | null;
}

export function DestinationPicker({ visible, onSelect, onClose, recentDestination }: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) {
      if (recentDestination) {
        return [recentDestination, ...allStations.slice(0, 50).filter((s) => s.id !== recentDestination.id)];
      }
      return allStations.slice(0, 50);
    }
    return allStations.filter((s) => s.name.includes(q));
  }, [query, recentDestination]);

  function handleSelect(station: Station) {
    setQuery('');
    onSelect(station);
  }

  function handleClose() {
    setQuery('');
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>목적지 설정</Text>
          <TouchableOpacity onPress={handleClose} testID="close-button">
            <Text style={styles.closeText}>닫기</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.input}
          placeholder="역 이름 검색"
          placeholderTextColor="#888"
          value={query}
          onChangeText={setQuery}
          testID="search-input"
        />
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={
            !query && recentDestination ? (
              <Text style={styles.sectionLabel} testID="recent-destination-header">
                이전 목적지
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.item}
              onPress={() => handleSelect(item)}
              testID={`station-item-${item.id}`}
            >
              <Text style={styles.stationName}>{item.name}</Text>
              <View style={[styles.lineBadge, { backgroundColor: item.lineColor }]}>
                <Text style={styles.lineText}>{item.line}호선</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingTop: 50,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeText: {
    color: '#a78bfa',
    fontSize: 16,
  },
  input: {
    backgroundColor: '#16213e',
    color: '#fff',
    marginHorizontal: 20,
    marginBottom: 12,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
  },
  sectionLabel: {
    color: '#8888aa',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  item: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
  },
  stationName: {
    color: '#fff',
    fontSize: 16,
  },
  lineBadge: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  lineText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
});
