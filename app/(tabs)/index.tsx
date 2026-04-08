import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { getRemainingStops } from '../../src/utils/stationRoute';

export default function HomeScreen() {
  const { result, loading, error, permissionDenied, refresh } = useNearestStation();
  const { arrival } = useArrivalInfo(result?.station.name ?? null);
  const { addFavorite, removeFavorite, isFavorite, loadFavorites, destination, setDestination, loadDestination } = useAppStore();
  const [pickerVisible, setPickerVisible] = useState(false);

  useEffect(() => {
    loadFavorites();
    loadDestination();
  }, []);

  const remainingStops =
    result && destination
      ? getRemainingStops(result.station.id, destination.id)
      : null;

  if (permissionDenied) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.icon}>📍</Text>
          <Text style={styles.title}>위치 권한 필요</Text>
          <Text style={styles.subtitle}>
            설정에서 위치 권한을 허용해 주세요.{'\n'}현재 탑승 중인 역을 감지하려면{'\n'}위치 권한이 필요합니다.
          </Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.loadingText}>위치 확인 중...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>새로고침</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.header}>지금 여기</Text>

        {result ? (
          <>
            <View style={[styles.stationCard, { borderLeftColor: result.station.lineColor }]}>
              <View style={styles.stationCardHeader}>
                <View style={[styles.lineBadge, { backgroundColor: result.station.lineColor }]}>
                  <Text style={styles.lineBadgeText}>{LINE_NAMES[result.station.line]}</Text>
                </View>
                <TouchableOpacity
                  onPress={() =>
                    isFavorite(result.station.id)
                      ? removeFavorite(result.station.id)
                      : addFavorite(result.station)
                  }
                >
                  <Text style={styles.favoriteIcon}>
                    {isFavorite(result.station.id) ? '⭐' : '☆'}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.stationName}>{result.station.name}</Text>
              <Text style={styles.distanceText}>
                현재 위치에서 약 {Math.round(result.distanceKm * 1000)}m
              </Text>
            </View>

            <View style={styles.destinationCard}>
              {destination ? (
                <View style={styles.destinationInfo}>
                  <Text style={styles.destinationArrow}>→</Text>
                  <View>
                    <Text style={styles.destinationName}>{destination.name}</Text>
                    {remainingStops !== null ? (
                      <Text style={styles.remainingText}>{remainingStops} 정거장 남음</Text>
                    ) : (
                      <Text style={styles.remainingText}>다른 노선</Text>
                    )}
                  </View>
                </View>
              ) : null}
              <TouchableOpacity
                style={styles.destinationButton}
                onPress={() => setPickerVisible(true)}
                testID="destination-button"
              >
                <Text style={styles.destinationButtonText}>
                  {destination ? '목적지 변경' : '목적지 설정'}
                </Text>
              </TouchableOpacity>
              {destination ? (
                <TouchableOpacity
                  onPress={() => setDestination(null)}
                  testID="destination-clear-button"
                >
                  <Text style={styles.clearText}>초기화</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {arrival && (
              <View style={styles.arrivalSection}>
                <Text style={styles.sectionTitle}>열차 도착 정보</Text>
                <ArrivalRow label="상행" items={arrival.up} />
                <ArrivalRow label="하행" items={arrival.down} />
              </View>
            )}
          </>
        ) : (
          <View style={styles.center}>
            <Text style={styles.icon}>🚶</Text>
            <Text style={styles.title}>지하철역 근처가 아닙니다</Text>
            <Text style={styles.subtitle}>지하철역 500m 이내에 있을 때{'\n'}현재 역이 표시됩니다.</Text>
            <TouchableOpacity style={styles.button} onPress={refresh}>
              <Text style={styles.buttonText}>새로고침</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <DestinationPicker
        visible={pickerVisible}
        onSelect={(station) => {
          setDestination(station);
          setPickerVisible(false);
        }}
        onClose={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

function ArrivalRow({
  label,
  items,
}: {
  label: string;
  items: { destination: string; arrivalMinutes: number }[];
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.arrivalRow}>
      <Text style={styles.arrivalLabel}>{label}</Text>
      <View>
        {items.map((item, idx) => (
          <Text key={idx} style={styles.arrivalItem}>
            {item.destination ? `${item.destination} · ` : ''}
            {item.arrivalMinutes === 0 ? '곧 도착' : `${item.arrivalMinutes}분 후`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  scroll: {
    padding: 24,
    flexGrow: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  header: {
    fontSize: 14,
    color: '#8888aa',
    marginBottom: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  stationCard: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 24,
    borderLeftWidth: 6,
    marginBottom: 16,
  },
  stationCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  favoriteIcon: {
    fontSize: 26,
  },
  lineBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  lineBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  stationName: {
    fontSize: 42,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 8,
  },
  distanceText: {
    fontSize: 14,
    color: '#8888aa',
  },
  destinationCard: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  destinationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  destinationArrow: {
    fontSize: 24,
    color: '#a78bfa',
    marginRight: 12,
  },
  destinationName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  remainingText: {
    fontSize: 13,
    color: '#8888aa',
    marginTop: 2,
  },
  destinationButton: {
    backgroundColor: '#a78bfa',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  destinationButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  clearText: {
    color: '#8888aa',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  arrivalSection: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
  },
  sectionTitle: {
    fontSize: 14,
    color: '#8888aa',
    marginBottom: 16,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
  },
  arrivalLabel: {
    fontSize: 15,
    color: '#aaaacc',
    fontWeight: '600',
  },
  arrivalItem: {
    fontSize: 15,
    color: '#ffffff',
    textAlign: 'right',
    marginBottom: 4,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#8888aa',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  loadingText: {
    fontSize: 16,
    color: '#8888aa',
  },
  errorText: {
    fontSize: 16,
    color: '#ff6b6b',
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#0052A4',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
