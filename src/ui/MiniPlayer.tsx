import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTracksById } from '../lib/library';
import { next, togglePlay, useCurrentId, usePlayer } from '../player/controller';
import { Artwork } from './Artwork';
import { colors, MINI_PLAYER_HEIGHT, radius } from './theme';

export function MiniPlayer({ style }: { style?: ViewStyle }) {
  const id = useCurrentId();
  const tracks = useTracksById();
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const track = id ? tracks[id] : undefined;
  if (!track) return null;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <View style={[styles.outer, style]} pointerEvents="box-none">
      <Pressable style={styles.card} onPress={() => router.push('/player')}>
        <Artwork trackId={track.id} size={44} rounded={8} />
        <View style={styles.text}>
          <Text numberOfLines={1} style={styles.title}>
            {track.title}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {buffering && playing ? 'Loading…' : track.artist}
          </Text>
        </View>
        <Pressable hitSlop={12} onPress={togglePlay} style={styles.button}>
          <Ionicons name={playing ? 'pause' : 'play'} size={26} color={colors.text} />
        </Pressable>
        <Pressable hitSlop={12} onPress={next} style={styles.button}>
          <Ionicons name="play-forward" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 8 },
  card: {
    height: MINI_PLAYER_HEIGHT,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceHigh,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontWeight: '700', fontSize: 14 },
  artist: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  button: { padding: 4 },
  track: { position: 'absolute', left: 12, right: 12, bottom: 4, height: 2, backgroundColor: colors.border, borderRadius: 1 },
  fill: { height: 2, backgroundColor: colors.accent, borderRadius: 1 },
});

