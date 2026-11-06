import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { artUrl } from '../lib/api';
import { hashString } from '../lib/format';
import { useConfig, useTracksById } from '../lib/library';
import { colors } from './theme';

const PALETTE = [
  ['#3A1C71', '#D76D77'],
  ['#0F2027', '#2C5364'],
  ['#42275A', '#734B6D'],
  ['#1F4037', '#99F2C8'],
  ['#232526', '#414345'],
  ['#4B134F', '#C94B4B'],
  ['#141E30', '#243B55'],
  ['#3E5151', '#DECBA4'],
  ['#2C3E50', '#FD746C'],
  ['#0B486B', '#F56217'],
] as const;

type Props = { trackId?: string; label?: string; size: number; rounded?: number; style?: ViewStyle };

function ArtworkInner({ trackId, label, size, rounded = 6, style }: Props) {
  const tracks = useTracksById();
  const config = useConfig();
  const track = trackId ? tracks[trackId] : undefined;
  const seed = hashString(trackId ?? label ?? 'x');
  const [a, b] = PALETTE[seed % PALETTE.length];
  const letter = (label ?? track?.title ?? '?').replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '#';
  const box = { width: size, height: size, borderRadius: rounded };
  return (
    <View style={[styles.wrap, box, style]}>
      <LinearGradient colors={[a, b]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Text style={[styles.letter, { fontSize: size * 0.42 }]}>{letter}</Text>
      {track?.artKey && config ? (
        <Image
          source={{ uri: artUrl(config, track.id) }}
          style={StyleSheet.absoluteFill}
          cachePolicy="disk"
          recyclingKey={track.id}
          transition={150}
        />
      ) : null}
    </View>
  );
}

export const Artwork = memo(ArtworkInner);

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceHigh },
  letter: { color: 'rgba(255,255,255,0.85)', fontWeight: '800' },
});

