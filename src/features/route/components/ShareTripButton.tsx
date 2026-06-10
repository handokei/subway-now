import { useCallback } from 'react';
import { Pressable, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { shareTripIntent } from '../utils/shareTrip';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';

interface Props {
  route: Route;
  currentStation: Station | null;
  destination: Station | null;
  totalStops: number;
  travelMinutes: number;
  testID?: string;
}

/**
 * PR #1069 follow-up — 경로 시스템 텍스트 공유 진입점.
 *
 * 트립 카드 영역(HomeScreen Route 섹션) 헤더에 노출된다. 필수 데이터(route/
 * currentStation/destination)가 빠진 상태면 자기 자신을 숨겨 잘못된 빈
 * 공유 시트가 뜨지 않게 한다.
 */
export function ShareTripButton({
  route,
  currentStation,
  destination,
  totalStops,
  travelMinutes,
  testID,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const onPress = useCallback(() => {
    void shareTripIntent({
      route,
      currentStation,
      destination,
      totalStops,
      travelMinutes,
      // shareTrip util은 (key, options) → string 시그니처만 사용 — react-i18next의
      // 광범위한 오버로드와 좁은 호환만 필요해 cast로 좁힌다.
      t: t as unknown as (key: string, options?: Record<string, unknown>) => string,
    });
  }, [route, currentStation, destination, totalStops, travelMinutes, t]);

  if (!route || !currentStation || !destination) return null;

  return (
    <Pressable
      onPress={onPress}
      testID={testID ?? 'route-share-button'}
      accessibilityRole="button"
      accessibilityLabel={t('share.trip.buttonLabel')}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: colors.hair,
      }}
    >
      <Text style={[typography.label, { color: colors.muted, fontWeight: '600' }]}>
        {t('share.trip.buttonLabel')}
      </Text>
    </Pressable>
  );
}
