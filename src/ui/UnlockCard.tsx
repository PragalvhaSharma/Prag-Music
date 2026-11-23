import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { unlockWithKey } from '../lib/library';
import { reloadSources } from '../player/controller';
import { Button } from './Button';
import { colors, radius } from './theme';

/** Web only: asks for the app key once, then this browser stays unlocked. */
export function UnlockCard() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    try {
      if (await unlockWithKey(key)) {
        setKey('');
        // A song restored under an older key would otherwise fail on the first Play.
        reloadSources();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Unlock this browser</Text>
      <Text style={styles.body}>Paste your Prag Music app key. It stays saved in this browser, so you only do this once.</Text>
      <TextInput
        value={key}
        onChangeText={setKey}
        onSubmitEditing={submit}
        placeholder="App key"
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Button label={busy ? 'Checking...' : 'Unlock'} icon="lock-open" kind="primary" onPress={submit} disabled={busy || !key.trim()} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 16,
    gap: 12,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  body: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  input: {
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
