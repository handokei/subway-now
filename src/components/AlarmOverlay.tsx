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

  // #741: dismiss UX 단순화 — 단일 버튼 + 통일 라벨("알람 끄기").
  // 동작은 알람 종류별로 분기 유지:
  //  - transfer: trip 유지. clearAlarmNotification만. 후속 도착 알람은 계속.
  //  - destination: trip 종료. killAllAlarms + onEndTrip.
  // Android 백 버튼/스와이프(onRequestClose)도 같은 분기를 따른다.
  // 보조 버튼("이 알람만 끄기")은 #673에서 도입했으나 destination/lock을 건드리지 않아
  // 다음 평가 사이클에 재발화 → 진동 재발생 회귀가 있어 제거. 미스파이어 root cause는
  // ADR-008 #739, 정적 misfire 가드(#727/#733), 알람 misfire 큐(#370~#373)에서 처리.
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
          <Text style={[styles.buttonText, { color: colors.onAccent }]}>
            {t('alarmOverlay.dismiss')}
          </Text>
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
