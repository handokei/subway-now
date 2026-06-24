/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: AlarmOverlay는 alarm 알람 표시 시점에 exit-info의
 * StationExitCard를 인라인 노출하는 orchestrator 역할이다. 후속 PR에서 orchestration
 * 슬라이스로 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { clearAlarmNotification } from '../utils/stationNotification';
import { killAllAlarms } from '../utils/alarmKill';
import { getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import stationsData from '../../../data/stations.json';
import type { LineNumber, Station } from '../../../shared/types/station';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { StationExitCard } from '../../exit-info/components/StationExitCard';

const allStations = stationsData as Station[];

interface AlarmOverlayProps {
  event: AlarmEvent;
  onDismiss: () => void;
  /**
   * 알람 대상역 노선 — StationExitCard 출구 안내에 사용 (#1289).
   * 미전달 시 출구 안내를 표시하지 않는다 (graceful hide).
   */
  line?: LineNumber | null;
}

export function AlarmOverlay({ event, onDismiss, line }: AlarmOverlayProps) {
  const isTransfer = event.type === 'transfer';
  const { t } = useTranslation();
  const title = t(isTransfer ? 'alarmOverlay.transferTitle' : 'alarmOverlay.arrivalTitle');
  const message = t(isTransfer ? 'alarmOverlay.transferMessage' : 'alarmOverlay.arrivalMessage', {
    station: getStationDisplayNameByName(event.stationName, allStations),
  });
  const { colors } = useTheme();

  // #806: dismiss는 알람 UI/진동만 끄고 trip(BoardingLock)은 절대 release하지 않는다.
  //   한 정거장 전(early) destination 알람을 끄면 trip이 종료되던 회귀의 fix.
  //   trip release는 도착역 station-passed 또는 자동 하차(useBoardingLockAutoRelease, #759)가
  //   감지한 시점에만 트리거 — dismiss는 그 라이프사이클에 관여하지 않는다.
  //
  // 분기는 알람 종류별로 후속 알람 정리 범위만 다르다:
  //  - transfer: clearAlarmNotification만 — 후속 도착 알람(예약/발사 예정)을 보존.
  //  - destination: killAllAlarms — 같은 도착역 후속 phase(imminent 등) 예약을 함께 차단,
  //    같은 trip 안에서 도착 알람을 재발사하지 않도록.
  //
  // Android 백 버튼/스와이프(onRequestClose)도 동일 분기.
  const handleDismiss = async () => {
    if (isTransfer) {
      await clearAlarmNotification();
    } else {
      await killAllAlarms();
    }
    onDismiss();
  };

  return (
    <Modal visible animationType="fade" testID="alarm-overlay" onRequestClose={handleDismiss}>
      <ScrollView
        contentContainerStyle={[styles.container, { backgroundColor: colors.bg }]}
        style={{ backgroundColor: colors.bg }}
        testID="alarm-overlay-scroll"
        bounces={false}
      >
        <Text style={[styles.title, { color: colors.accent }]} testID="alarm-overlay-title">
          {title}
        </Text>
        <Text style={[styles.station, { color: colors.ink }]} testID="alarm-overlay-message">
          {message}
        </Text>
        {line != null && (
          <View style={styles.exitSection} testID="alarm-overlay-exit-section">
            <StationExitCard stationName={event.stationName} line={line} />
          </View>
        )}
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.accent }]}
          onPress={handleDismiss}
          testID="alarm-dismiss-button"
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('alarmOverlay.dismiss')}
          accessibilityHint={t('a11y.alarm.dismissHint')}
        >
          <Text style={[styles.buttonText, { color: colors.onAccent }]}>
            {t('alarmOverlay.dismiss')}
          </Text>
        </TouchableOpacity>
      </ScrollView>
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
    ...typography.title,
    fontWeight: '700',
    marginBottom: spacing.xxl,
    letterSpacing: 2,
  },
  station: {
    ...typography.hero,
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
    ...typography.title,
    fontWeight: '800',
  },
  exitSection: {
    width: '100%',
    marginBottom: spacing.xxl,
  },
});
