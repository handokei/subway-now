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
  // Hermes/iOS Intl 구현이 timeZone+formatToParts(weekday) 조합에서 일부 part를
  // 누락해 throw하는 사례가 관측됐다(#1083 E2E 회귀). 배너는 보조 UI이므로 어떤 이유로든
  // window 산출이 실패하면 조용히 null을 반환해 화면 전체 크래시를 막는다.
  let window: ReturnType<typeof getServiceWindow>;
  try {
    window = getServiceWindow({ stationName, line, now });
  } catch {
    return null;
  }
  const { status, firstTrain } = window;

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
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
});
