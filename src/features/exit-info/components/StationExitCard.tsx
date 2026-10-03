import { StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing } from '../../../shared/theme';
import type { LineNumber } from '../../../shared/types/station';
import { useStationExits } from '../hooks/useStationExits';
import type { ExitInfoProvider } from '../providers/types';

interface Props {
  stationName: string | null;
  line: LineNumber | null;
  /**
   * 사용자가 설정한 목적지 시설 텍스트 — 매칭 출구를 앞으로 정렬하는 데 사용.
   * 없으면 원본 순서 그대로 표시한다.
   */
  destination?: string | null;
  /** 테스트/DI용. 미지정 시 MockExitInfoProvider 사용. */
  provider?: ExitInfoProvider;
}

/**
 * 역 출구 목록을 표시하는 카드 컴포넌트 (#1289).
 *
 * - `useStationExits`를 내부적으로 호출해 출구 데이터를 로드한다.
 * - destination이 주어지면 매칭 출구를 앞으로 정렬해 표시한다.
 * - 데이터가 없거나 로딩 중이면 아무것도 렌더하지 않는다 (graceful hide).
 * - stationName 또는 line이 null이면 즉시 null 반환 (no-op).
 */
export function StationExitCard({ stationName, line, destination, provider }: Props) {
  const { colors } = useTheme();
  const { ranked, loading } = useStationExits({ stationName, line, destination, provider });

  if (!stationName || !line) return null;
  if (loading || ranked.length === 0) return null;

  return (
    <View style={styles.container} testID="station-exit-card">
      <Text style={[typography.label, { color: colors.subtle }, styles.label]} testID="station-exit-card-label">
        출구 안내
      </Text>
      <View style={styles.list}>
        {ranked.map(({ exit, matchesDestination }) => (
          <View
            key={exit.exitNumber}
            style={[
              styles.row,
              { borderColor: matchesDestination ? colors.accent : colors.card },
            ]}
            testID={`exit-row-${exit.exitNumber}`}
          >
            <Text
              style={[
                typography.bodySm,
                { color: matchesDestination ? colors.accent : colors.ink, fontWeight: '600' },
              ]}
              testID={`exit-number-${exit.exitNumber}`}
            >
              {exit.exitNumber}번 출구
            </Text>
            <Text
              style={[typography.bodySm, { color: colors.subtle, flex: 1 }]}
              testID={`exit-facilities-${exit.exitNumber}`}
              numberOfLines={1}
            >
              {exit.facilities.join(' · ')}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  label: {
    marginBottom: spacing.xs,
  },
  list: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderRadius: 4,
  },
});
