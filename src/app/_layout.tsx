import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { bootstrap } from '../ui/bootstrap';
import { colors } from '../ui/theme';

void SystemUI.setBackgroundColorAsync(colors.bg);

export default function RootLayout() {
  useEffect(() => {
    void bootstrap();
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="playlist/[id]" options={{ headerShown: true, title: '', headerBackTitle: 'Back' }} />
        <Stack.Screen name="player" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

