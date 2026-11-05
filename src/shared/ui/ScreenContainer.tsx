import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

interface Props {
  children: ReactNode;
  edges?: Edge[];
  style?: ViewStyle;
  testID?: string;
}

export function ScreenContainer({ children, edges, style, testID }: Props) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.bg }, style]}
      edges={edges}
      testID={testID}
    >
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
