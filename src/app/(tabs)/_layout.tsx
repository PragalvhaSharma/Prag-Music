import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MiniPlayer } from '../../ui/MiniPlayer';
import { colors } from '../../ui/theme';

const TAB_BAR = 52;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarStyle: {
            backgroundColor: colors.bg,
            borderTopColor: colors.border,
            height: TAB_BAR + insets.bottom,
          },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textFaint,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: 'Home', tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color as string} size={size} /> }}
        />
        <Tabs.Screen
          name="songs"
          options={{ title: 'Songs', tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" color={color as string} size={size} /> }}
        />
      </Tabs>
      <MiniPlayer style={{ position: 'absolute', left: 0, right: 0, bottom: TAB_BAR + insets.bottom + 6 }} />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg } });

