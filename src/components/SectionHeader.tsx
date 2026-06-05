import { StyleSheet, Text, type TextStyle } from 'react-native';
import { useTheme, typography, spacing } from '../shared/theme';

interface Props {
  label: string;
  style?: TextStyle;
  testID?: string;
}

export function SectionHeader({ label, style, testID }: Props) {
  const { colors } = useTheme();
  return (
    <Text
      style={[typography.label, styles.header, { color: colors.muted }, style]}
      testID={testID}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.lg,
  },
});
