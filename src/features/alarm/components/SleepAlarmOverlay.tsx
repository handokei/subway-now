/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: SleepAlarmOverlay는 알람 표시 시점에 exit-info의
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

interface SleepAlarmOverlayProps {
  /**
   * 취침모드 전용 게이트 (#2258 재발 방지, refactor #2520).
   *
   * `useAlarmEventStore.setAlarmEvent`가 이미 sleepMode=false일 때 alarmEvent 자체를
   * set하지 않으므로 (중앙 게이트), 정상 호출 경로에서는 이 컴포넌트가 sleepMode=false로
   * 마운트될 일이 없다. 그럼에도 컴포넌트 자체에 게이트를 중복 배치하는 이유는 #2258이
   * "store 게이트를 우회하는 별도 마운트 경로"에서 발생했던 회귀이기 때문 — 이 컴포넌트가
   * 향후 다른 호출부에서 재사용되더라도 구조적으로 비취침 상태에서는 절대 화면을 그리지
   * 않도록 defense-in-depth를 건다.
   */
  sleepMode: boolean;
  event: AlarmEvent;
  onDismiss: () => void;
  /**
   * 알람 대상역 노선 — StationExitCard 출구 안내에 사용 (#1289).
   * 미전달 시 출구 안내를 표시하지 않는다 (graceful hide).
   */
  line?: LineNumber | null;
}

export function SleepAlarmOverlay({ sleepMode, event, onDismiss, line }: SleepAlarmOverlayProps) {
  // Rules of Hooks — sleepMode 분기와 무관하게 항상 동일한 순서로 호출해야 하므로
  // early return보다 먼저 hook을 모두 호출한다. 아래 #2258 방어선은 hook 호출 이후에 온다.
  const { t } = useTranslation();
  const { colors } = useTheme();

  // #2258 방어선 — 비취침이면 아예 렌더하지 않는다. 위 JSDoc 참고.
  if (!sleepMode) {
    return null;
  }

  const isTransfer = event.type === 'transfer';
  const title = t(isTransfer ? 'alarmOverlay.transferTitle' : 'alarmOverlay.arrivalTitle');
  const message = t(isTransfer ? 'alarmOverlay.transferMessage' : 'alarmOverlay.arrivalMessage', {
    station: getStationDisplayNameByName(event.stationName, allStations),
  });

  // #806: dismiss는 알람 UI/진동만 끄고 trip(BoardingLock)은 절대 release하지 않는다.
  //   한 정거장 전(early) destination 알람을 끄면 trip이 종료되던 회귀의 fix.
  //   trip release는 도착역 station-passed 또는 자동 하차(useBoardingLockAutoRelease, #759)가
  //   감지한 시점에만 트리거 — dismiss는 그 라이프사이클에 관여하지 않는다.
  //   (이 함수는 BoardingLock storage를 import조차 하지 않는다 — 구조적으로 건드릴 수 없다.)
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
