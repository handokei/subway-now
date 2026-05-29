import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AlarmEvent } from '../store/useAppStore';
import { clearAlarmNotification } from '../utils/stationNotification';
import { killAllAlarms } from '../utils/alarmKill';
import { getStationDisplayNameByName } from '../utils/stationDisplay';
import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import { useTheme, typography, spacing, radius } from '../theme';

const allStations = stationsData as Station[];

interface AlarmOverlayProps {
  event: AlarmEvent;
  onDismiss: () => void;
  /**
   * 도착 알람 dismiss 시 호출 — trip 종료 처리(lock release + destination clear).
   * 환승 알람 dismiss는 trip 유지이므로 호출 안 함.
   */
  onEndTrip: () => void;
}

export function AlarmOverlay({ event, onDismiss, onEndTrip }: AlarmOverlayProps) {
  const isTransfer = event.type === 'transfer';
  const { t } = useTranslation();
  const title = t(isTransfer ? 'alarmOverlay.transferTitle' : 'alarmOverlay.arrivalTitle');
  const message = t(isTransfer ? 'alarmOverlay.transferMessage' : 'alarmOverlay.arrivalMessage', {
    station: getStationDisplayNameByName(event.stationName, allStations),
  });
  const { colors } = useTheme();

  // #633: dismiss 동작이 알람 종류별로 분기.
  //  - transfer: trip 유지. 진동/사운드 + 이 알람만 정지. 후속 도착 알람은 계속.
  //  - destination: trip 종료. killAllAlarms로 진동/사운드/예약 전부 청소 + onEndTrip으로
  //    BoardingLock release + destination clear까지 위임 (호출자 책임).
  const handleDismiss = async () => {
    if (isTransfer) {
      await clearAlarmNotification();
    } else {
      await killAllAlarms();
      onEndTrip();
    }
    onDismiss();
  };

  return (
    <Modal visible animationType="fade" testID="alarm-overlay" onRequestClose={handleDismiss}>
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <Text style={[styles.title, { color: colors.accent }]}>{title}</Text>
        <Text style={[styles.station, { color: colors.ink }]}>{message}</Text>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.accent }]}
          onPress={handleDismiss}
          testID="alarm-dismiss-button"
          activeOpacity={0.7}
        >
          <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('alarmOverlay.dismiss')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxxl,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: spacing.xxl,
    letterSpacing: 2,
  },
  station: {
    fontSize: 48,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 64,
    marginBottom: 64,
  },
  button: {
    paddingHorizontal: 64,
    paddingVertical: spacing.xxl,
    borderRadius: radius.pill,
  },
  buttonText: {
    fontSize: 28,
    fontWeight: '800',
  },
});
