import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme';
import { openAppSettings } from '../utils/openAppSettings';

interface LocationStateViewProps {
  permissionDenied: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function LocationStateView({ permissionDenied, loading, error, onRetry }: LocationStateViewProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (permissionDenied) {
    // iOS에서 사용자가 권한을 영구 거부하면 requestPermissionsAsync()는 OS dialog 없이
    // 즉시 denied를 반환한다. 따라서 "권한 요청" 버튼은 무의미하고, 유일한 복구 경로인
    // "설정 열기"만 노출한다.
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>{t('permissions.locationRequiredShort')}</Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.accent }]}
            onPress={openAppSettings}
            testID="location-open-settings-button"
          >
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('permissions.openSettings')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>{t('permissions.locating')}</Text>
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
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('common.retry')}</Text>
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
