/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: SleepAlarmOverlay는 알람 표시 시점에 exit-info의
 * StationExitCard를 인라인 노출하는 orchestrator 역할이다. 후속 PR에서 orchestration
 * 슬라이스로 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { clearAlarmNotification } from '../utils/stationNotification';
import { getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import stationsData from '../../../data/stations.json';
import type { LineNumber, Station } from '../../../shared/types/station';
import { useTheme, typography, spacing, radiusGlass, lineTint } from '../../../shared/theme';
import { LineGlowBackground } from '../../../shared/ui/LineGlowBackground';
import { getLineLabel } from '../../../shared/ui/LineBadge';
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
   * 알람 대상역 노선 — StationExitCard 출구 안내 + Line Glass 칩/글로우에 사용 (#1289).
   * 미전달 시 출구 안내·노선 칩을 표시하지 않고, 글로우는 현재 틴트 노선(store)을 따른다.
   */
  line?: LineNumber | null;
}

export function SleepAlarmOverlay({ sleepMode, event, onDismiss, line }: SleepAlarmOverlayProps) {
  // Rules of Hooks — sleepMode 분기와 무관하게 항상 동일한 순서로 호출해야 하므로
  // early return보다 먼저 hook을 모두 호출한다. 아래 #2258 방어선은 hook 호출 이후에 온다.
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();

  // #2258 방어선 — 비취침이면 아예 렌더하지 않는다. 위 JSDoc 참고.
  if (!sleepMode) {
    return null;
  }

  const isTransfer = event.type === 'transfer';
  const station = getStationDisplayNameByName(event.stationName, allStations);
  // #3100 — N역 전 칸(band = 실제 남은 정거장 수)은 "N정거장 전" 문구, 기본 칸(1역 전)은 현행 문구.
  const { band } = event;
  const title =
    band === undefined
      ? t(isTransfer ? 'alarmOverlay.transferTitle' : 'alarmOverlay.arrivalTitle')
      : t(isTransfer ? 'alarms.bandTransferTitle' : 'alarms.bandArrivalTitle', { stops: band });
  const message =
    band === undefined
      ? t(isTransfer ? 'alarmOverlay.transferMessage' : 'alarmOverlay.arrivalMessage', { station })
      : t('alarmOverlay.bandMessage', { station, stops: band });
  const tint = line != null ? lineTint(line, isDark) : null;

  // #806: dismiss는 알람 UI/진동만 끄고 trip(BoardingLock)은 절대 release하지 않는다.
  //   한 정거장 전(early) destination 알람을 끄면 trip이 종료되던 회귀의 fix.
  //   trip release는 도착역 station-passed 또는 자동 하차(useBoardingLockAutoRelease, #759)가
  //   감지한 시점에만 트리거 — dismiss는 그 라이프사이클에 관여하지 않는다.
  //   (이 함수는 BoardingLock storage를 import조차 하지 않는다 — 구조적으로 건드릴 수 없다.)
  //
  // #3100 D2 — 모든 알람의 닫기 = 진동 중단 + 알람 알림 1건 dismiss(`clearAlarmNotification`)만. 오버레이 소스가
  // 칸마다 도착하는 backend companion뿐이므로 `killAllAlarms`(전체 예약 cancel)를 쓰면 이후 칸의 안전망 백업·
  // tripEndOffer·lastTrainAlarm이 함께 죽는다. 5분 전역 무음(setDismissSilence)도 호출부에서 제거됐다.
  //
  // Android 백 버튼/스와이프(onRequestClose)도 동일.
  const handleDismiss = async () => {
    await clearAlarmNotification();
    onDismiss();
  };

  return (
    <Modal visible animationType="fade" testID="alarm-overlay" onRequestClose={handleDismiss}>
      <View style={[styles.root, { backgroundColor: colors.bg }]}>
        {/* Line Glass — 대상역 노선색 글로우. line 미전달 시 현재 틴트 노선(store). */}
        <LineGlowBackground line={line} />
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <ScrollView
            contentContainerStyle={styles.container}
            testID="alarm-overlay-scroll"
            bounces={false}
          >
            <View style={styles.center}>
              {tint != null && line != null && (
                <View
                  style={[styles.chip, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}
                  testID="alarm-overlay-line-chip"
                >
                  <View style={[styles.chipDot, { backgroundColor: tint.base }]} />
                  <Text style={[styles.chipText, { color: tint.text }]}>{getLineLabel(line)}</Text>
                </View>
              )}
              <Text style={[styles.title, { color: colors.accent }]} testID="alarm-overlay-title">
                {title}
              </Text>
              <Text style={[styles.station, { color: colors.ink }]} testID="alarm-overlay-message">
                {message}
              </Text>
            </View>
            {line != null && (
              <View style={styles.exitSection} testID="alarm-overlay-exit-section">
                <StationExitCard stationName={event.stationName} line={line} />
              </View>
            )}
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.inkStrong }]}
              onPress={handleDismiss}
              testID="alarm-dismiss-button"
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('alarmOverlay.dismiss')}
              accessibilityHint={t('a11y.alarm.dismissHint')}
            >
              <View
                style={[styles.buttonDotRing, { backgroundColor: colors.alarmDotRing }]}
                testID="alarm-dismiss-dot-ring"
              >
                <View
                  style={[styles.buttonDot, { backgroundColor: colors.alarmDot }]}
                  testID="alarm-dismiss-dot"
                />
              </View>
              <Text style={[styles.buttonText, { color: colors.onInkStrong }]}>
                {t('alarmOverlay.dismiss')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxl,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radiusGlass.pill,
    borderWidth: 1,
    marginBottom: spacing.xxl,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { ...typography.bodySm, fontWeight: '700' },
  title: {
    ...typography.bodyBase,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  station: {
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: -2,
    lineHeight: 56,
    textAlign: 'center',
  },
  exitSection: {
    width: '100%',
    marginBottom: spacing.xl,
  },
  button: {
    height: 60,
    borderRadius: radiusGlass.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  buttonDotRing: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDot: { width: 8, height: 8, borderRadius: 4 },
  buttonText: {
    ...typography.bodyLg,
    fontWeight: '700',
  },
});
