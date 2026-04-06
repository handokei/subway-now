import { Tabs } from 'expo-router';
import { Text } from 'react-native';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#1a1a2e',
          borderTopColor: '#2a2a4a',
        },
        tabBarActiveTintColor: '#ffffff',
        tabBarInactiveTintColor: '#666688',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '현재 역',
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🚇</Text>,
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: '즐겨찾기',
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>⭐</Text>,
        }}
      />
    </Tabs>
  );
}
