import { useEffect } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../src/store/useAppStore';

export default function SettingsScreen() {
  const { sleepMode, setSleepMode, loadSleepMode } = useAppStore();

  useEffect(() => {
    loadSleepMode();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>설정</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>알람</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>취침 모드</Text>
            <Text style={styles.settingDesc}>
              이어폰 연결 시 기상 알람음으로 울립니다
            </Text>
          </View>
          <Switch
            value={sleepMode}
            onValueChange={setSleepMode}
            trackColor={{ false: '#2a2a4a', true: '#a78bfa' }}
            thumbColor={sleepMode ? '#ffffff' : '#666688'}
            testID="sleep-mode-switch"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    fontSize: 14,
    color: '#8888aa',
    letterSpacing: 2,
    textTransform: 'uppercase',
    padding: 24,
    paddingBottom: 16,
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
  },
  sectionTitle: {
    fontSize: 14,
    color: '#8888aa',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
    marginBottom: 4,
  },
  settingDesc: {
    fontSize: 13,
    color: '#8888aa',
    lineHeight: 18,
  },
});
