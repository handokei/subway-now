import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { StationArrival } from '../api/arrivalApi';
import { useTheme, typography } from '../../../shared/theme';

interface Props {
  arrival: StationArrival | null;
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
