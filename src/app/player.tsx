import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatTime } from '../lib/format';
import { useTracksById } from '../lib/library';
import {
  cycleRepeat,
  jumpTo,
  next,
  previous,
  seek,
  toggleShuffle,
  togglePlay,
  useCurrentId,
  usePlayer,
} from '../player/controller';
import { Artwork } from '../ui/Artwork';
import { colors } from '../ui/theme';

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tracks = useTracksById();
  const id = useCurrentId();
  const track = id ? tracks[id] : undefined;
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const label = usePlayer((s) => s.sourceLabel);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    if (!track) close();
  }, [track]);

  const upNext = useMemo(() => queue.slice(index + 1, index + 31).map((qid, i) => ({ qid, logical: index + 1 + i })), [queue, index]);
  if (!track) return null;
  const art = Math.min(width - 48, 380);
  const total = duration || track.durationSec;
  const shown = scrub ?? position;

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 30 }}>
      <View style={styles.top}>
        <Pressable hitSlop={12} onPress={close}>
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <Text style={styles.from} numberOfLines={1}>
          {label ? `Playing from ${label}` : 'Now playing'}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={{ alignItems: 'center', marginTop: 18 }}>
        <Artwork trackId={track.id} size={art} rounded={18} />
      </View>

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>
          {track.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {track.artist}
        </Text>
      </View>

      <View style={styles.scrub}>
        <Slider
          minimumValue={0}
          maximumValue={Math.max(1, total)}
          value={shown}
          onValueChange={setScrub}
          onSlidingComplete={(v) => {
            seek(v);
            setScrub(null);
          }}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.text}
        />
        <View style={styles.times}>
          <Text style={styles.time}>{formatTime(shown)}</Text>
          <Text style={styles.time}>{buffering && playing ? 'Loading…' : `-${formatTime(Math.max(0, total - shown))}`}</Text>
        </View>
      </View>

      <View style={styles.controls}>
        <Pressable hitSlop={10} onPress={toggleShuffle}>
          <Ionicons name="shuffle" size={24} color={shuffle ? colors.accent : colors.textDim} />
        </Pressable>
        <Pressable hitSlop={10} onPress={previous}>
          <Ionicons name="play-back" size={36} color={colors.text} />
        </Pressable>
        <Pressable onPress={togglePlay} style={styles.play}>
          <Ionicons name={playing ? 'pause' : 'play'} size={36} color={colors.accentInk} style={!playing && { marginLeft: 4 }} />
        </Pressable>
        <Pressable hitSlop={10} onPress={next}>
          <Ionicons name="play-forward" size={36} color={colors.text} />
        </Pressable>
        <Pressable hitSlop={10} onPress={cycleRepeat}>
          <View>
            <Ionicons name="repeat" size={24} color={repeat === 'off' ? colors.textDim : colors.accent} />
            {repeat === 'one' ? <Text style={styles.one}>1</Text> : null}
          </View>
        </Pressable>
      </View>

      {upNext.length ? (
        <View style={styles.queue}>
          <Text style={styles.queueTitle}>Up next</Text>
          {upNext.map(({ qid, logical }) => {
            const t = tracks[qid];
            if (!t) return null;
            return (
              <Pressable key={`${logical}-${qid}`} onPress={() => jumpTo(logical)} style={({ pressed }) => [styles.qRow, pressed && { opacity: 0.6 }]}>
                <Artwork trackId={qid} size={40} rounded={6} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.qTitle} numberOfLines={1}>
                    {t.title}
                  </Text>
                  <Text style={styles.qArtist} numberOfLines={1}>
                    {t.artist}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  from: { color: colors.textDim, fontSize: 13, fontWeight: '600', flex: 1, textAlign: 'center' },
  info: { paddingHorizontal: 24, marginTop: 26 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  artist: { color: colors.textDim, fontSize: 17, marginTop: 4 },
  scrub: { paddingHorizontal: 16, marginTop: 18 },
  times: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  time: { color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 30, marginTop: 18 },
  play: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  one: { position: 'absolute', right: -6, top: -6, color: colors.accent, fontSize: 10, fontWeight: '900' },
  queue: { marginTop: 34, paddingHorizontal: 20 },
  queueTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 8 },
  qRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  qTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  qArtist: { color: colors.textDim, fontSize: 12, marginTop: 2 },
});

