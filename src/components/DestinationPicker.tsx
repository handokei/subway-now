import React, { useState, useMemo } from 'react';
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
import { StationMap } from './StationMap';
import { haversine } from '../utils/haversine';


const MAP_RADIUS_KM = 5;

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

  const mapAvailable = !!(userLat && userLng);

  const mapStations = useMemo(() => {
    if (!userLat || !userLng) return [];
    return allStations.filter(
      (s) => haversine(userLat, userLng, s.lat, s.lng) <= MAP_RADIUS_KM
    );
  }, [userLat, userLng]);

  const suggestions = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return allStations.filter((s) => s.name.includes(q)).slice(0, 8);
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

        <View style={styles.overlay}>
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
                    <Text style={styles.lineText}>{s.line}호선</Text>
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
    backgroundColor: '#1a1a2e',
  },
  mapFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  mapFallbackText: {
    color: '#8888aa',
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
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 12,
    backgroundColor: 'rgba(26, 26, 46, 0.92)',
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
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
  },
  dropdown: {
    backgroundColor: '#16213e',
    marginHorizontal: 20,
    marginTop: 4,
    borderRadius: 8,
    overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4a',
  },
  suggestionName: {
    color: '#fff',
    fontSize: 15,
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
