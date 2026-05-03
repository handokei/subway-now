import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

interface LocationStateViewProps {
  permissionDenied: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function LocationStateView({ permissionDenied, loading, error, onRetry }: LocationStateViewProps) {
  const { colors } = useTheme();

  if (permissionDenied) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>위치 권한이 필요합니다.</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={onRetry} testID="location-retry-button">
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>권한 요청</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
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
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={onRetry} testID="location-retry-button">
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return null;
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
});
