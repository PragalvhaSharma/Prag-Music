import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors, radius } from './theme';

type Props = {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ label, icon, onPress, kind = 'secondary', disabled, style }: Props) {
  const primary = kind === 'primary';
  const fg = primary ? colors.accentInk : kind === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : styles.secondary,
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: radius.xl,
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceHigh },
  label: { fontSize: 15, fontWeight: '700' },
});

