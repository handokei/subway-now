import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { StationArrival } from '../api/arrivalApi';
import { useTheme, typography } from '../../../shared/theme';

interface Props {
  arrival: StationArrival | null;
}

/**
 * #1922 — ETA 행을 사용자 UI에 노출할지 결정. `true` 반환 = 숨김, `false` = 노출.
 *
 * MOCK_ARRIVALS(`isMock=true && source 미지정`)는 데모용 정적 값이라 실측이 전혀 아니다.
 * 사용자에게 "도착 예정 13:54 / 5분 남았다" 같은 모순된 ETA가 노출되는 회귀를 차단하기 위해
 * 호출자는 본 helper로 ETA 행 자체를 숨긴다.
 *
 * 반환값 (true = 숨김 / false = 노출):
 *   - arrival === null: true (숨김) — 표시할 데이터 자체 없음.
 *   - source === 'closed': true (숨김) — 운행 종료, ETA 의미 없음.
 *   - isMock === true + source 미지정: true (숨김) — hardcoded MOCK_ARRIVALS 정적 값.
 *   - source === 'schedule': false (노출) — wall-clock anchor 기반 정상 카운트다운.
 *   - source === 'realtime' 또는 기본 (isMock=false): false (노출).
 */
export function shouldHideArrivalEta(arrival: StationArrival | null): boolean {
  if (!arrival) return true;
  if (arrival.source === 'closed') return true;
  if (arrival.isMock === true && arrival.source !== 'schedule') return true;
  return false;
}

/**
 * 도착정보의 source(실시간/시간표/운행종료)에 따라 사용자에게 적절한 알림 텍스트를 노출.
 * 홈/favorites/위젯 등 여러 화면에서 동일한 라벨 분기 로직을 공유하기 위해 분리.
 * source가 'realtime'이거나 arrival이 null이면 null 반환.
 */
export function ArrivalSourceNotice({ arrival }: Props): ReactElement | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!arrival) return null;

  if (arrival.source === 'closed') {
    return (
      <Text
        style={[styles.notice, { color: colors.muted }]}
        testID="arrival-closed-notice"
      >
        {t('home.closedNotice')}
      </Text>
    );
  }

  if (arrival.source === 'schedule') {
    return (
      <Text
        style={[styles.notice, { color: colors.warn }]}
        testID="arrival-schedule-notice"
      >
        {t('home.scheduleNotice')}
      </Text>
    );
  }

  if (arrival.isMock) {
    return (
      <Text
        style={[styles.notice, { color: colors.warn }]}
        testID="arrival-mock-notice"
      >
        {t('home.mockNotice')}
      </Text>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  notice: {
    ...typography.captionSm,
    marginBottom: 8,
  },
});
