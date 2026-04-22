import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { AlarmEvent } from '../store/useAppStore';
import { clearAlarmNotification } from '../utils/stationNotification';
import { colors, typography, spacing, radius } from '../theme';

interface AlarmOverlayProps {
  event: AlarmEvent;
  onDismiss: () => void;
}

export function AlarmOverlay({ event, onDismiss }: AlarmOverlayProps) {
  const isTransfer = event.type === 'transfer';
  const title = isTransfer ? '환승 알림' : '하차 알림';
  const message = isTransfer
    ? `${event.stationName}에서\n환승하세요`
    : `${event.stationName}에서\n내리세요`;

  const handleDismiss = async () => {
    await clearAlarmNotification();
    onDismiss();
  };

  return (
    <Modal visible animationType="fade" testID="alarm-overlay" onRequestClose={handleDismiss}>
      <View style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.station}>{message}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={handleDismiss}
          testID="alarm-dismiss-button"
          activeOpacity={0.7}
        >
          <Text style={styles.buttonText}>알람 끄기</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxxl,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.accent,
    marginBottom: spacing.xxl,
    letterSpacing: 2,
  },
  station: {
    fontSize: 48,
    fontWeight: '900',
    color: colors.ink,
    textAlign: 'center',
    lineHeight: 64,
    marginBottom: 64,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: 64,
    paddingVertical: spacing.xxl,
    borderRadius: radius.pill,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
  },
});
