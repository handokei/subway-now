/* eslint-disable import/no-restricted-paths --
 * `getServiceWindow`는 1~9호선 timetable JSON과 강하게 결합되어 있어 도메인 슬라이스
 * `src/features/route/utils/`에 위치한다. 본 배너는 여러 feature 화면(HomeScreen 등)에서
 * 공통으로 노출될 운행시간 외 안내 UI이므로 shared/ui에 두고, util 참조만 file-level로
 * 옵트인 처리한다 (#1066).
 */
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { LineNumber } from '../types/station';
import { getServiceWindow } from '../../features/route/utils/serviceWindow';
import { useTheme, typography, spacing, radius } from '../theme';

interface Props {
  stationName: string;
  line: LineNumber;
  /** 미지정 시 `new Date()`. 테스트/스토리북 등에서 주입 가능. */
  now?: Date;
}

/**
 * 운행 시간 외(첫차 전 / 막차 후) 안내 배너 (#1066).
 *
 * - `getServiceWindow`(#1052)가 산출한 status 기반.
 * - `in-service` / `unknown`이면 렌더하지 않는다(`null`).
 * - 색은 `useTheme().colors.warn`을 사용해 라이트/다크 공통 톤 유지.
 *
 * NOTE: HomeScreen 등 화면 wiring은 후속 PR.
 */
export function ServiceWindowBanner({ stationName, line, now }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // #1088(safe Intl helper) 머지 이후 getServiceWindow는 throw 대신 status='unknown' 반환 →
  // 별도 try/catch 불필요. unknown 분기에서 null을 반환하는 아래 가드가 안전망 역할.
  const { status, firstTrain } = getServiceWindow({ stationName, line, now });

  // 운행 중이거나 timetable unknown이면 안내 불필요.
  // firstTrain은 pre-first/post-last 분기일 때 getServiceWindow가 보장하는 non-null.
  if (status !== 'pre-first' && status !== 'post-last') {
    return null;
  }

  const message =
    status === 'pre-first'
      ? t('service.window.preFirst', { time: firstTrain })
      : t('service.window.postLast', { time: firstTrain });

  return (
    <View style={styles.outer}>
      <View
        style={[styles.container, { backgroundColor: colors.card, borderColor: colors.warn }]}
        testID="service-window-banner"
        accessibilityRole="alert"
      >
        <Text
          style={[typography.body, { color: colors.warn, fontWeight: '600' }]}
          testID="service-window-banner-text"
        >
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 외곽 spacing을 배너가 직접 소유한다. HomeScreen 등 consumer가 wrapper에
  // padding을 두면 운행 중(=배너 null)에도 phantom 여백이 남아 viewport-tight
  // layout(E2E scrollUntilVisible 등)에서 회귀를 일으킨다(#1083).
  outer: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
  },
  container: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
});
