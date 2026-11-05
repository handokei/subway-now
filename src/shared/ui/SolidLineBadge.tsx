import { StyleSheet, Text, View } from 'react-native';
import { typography } from '../theme';
import { getLineLabel } from './LineBadge';

interface SolidLineBadgeProps {
  line: string;
  color: string;
  testID?: string;
}

/** 노선색 배경의 솔리드 라벨 배지 (홈 이전 목적지 행·즐겨찾기 칩 공용). */
export function SolidLineBadge({ line, color, testID }: SolidLineBadgeProps) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]} testID={testID}>
      <Text style={styles.text}>{getLineLabel(line)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  text: {
    color: '#fff', // 노선색(lineColor) 배경 위 텍스트 — 항상 흰색 유지
    ...typography.micro,
    fontWeight: 'bold',
  },
});
