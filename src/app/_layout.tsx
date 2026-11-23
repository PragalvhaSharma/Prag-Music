import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { togglePlay } from '../player/controller';
import { bootstrap } from '../ui/bootstrap';
import { colors } from '../ui/theme';

void SystemUI.setBackgroundColorAsync(colors.bg);

const isWeb = Platform.OS === 'web';

/** Web: the space bar plays and pauses, except while typing in a field. */
function useSpaceToPlay() {
  useEffect(() => {
    if (!isWeb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function RootLayout() {
  useEffect(() => {
    void bootstrap();
  }, []);
  useSpaceToPlay();
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {/* On a wide browser window the phone layout sits in a centred column. */}
      <View style={isWeb ? styles.webColumn : styles.fill}>
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
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webColumn: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
});

