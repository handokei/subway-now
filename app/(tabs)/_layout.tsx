import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { GlassTabBar } from '../../src/shared/ui/GlassTabBar';

export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabs.current') }} />
      <Tabs.Screen name="map" options={{ title: t('tabs.map') }} />
      <Tabs.Screen name="favorites" options={{ title: t('tabs.favorites') }} />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings') }} />
    </Tabs>
  );
}
