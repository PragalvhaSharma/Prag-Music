import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { searchKey } from '../../lib/format';
import { useLibrary } from '../../lib/library';
import { useStats } from '../../lib/stats';
import type { Track } from '../../lib/types';
import { playTracks } from '../../player/controller';
import { TRACK_ROW_HEIGHT, TrackRow } from '../../ui/TrackRow';
import { colors, radius } from '../../ui/theme';

type Sort = 'title' | 'artist' | 'plays';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'title', label: 'A–Z' },
  { id: 'artist', label: 'Artist' },
  { id: 'plays', label: 'Most played' },
];

export default function Songs() {
  const insets = useSafeAreaInsets();
  const library = useLibrary();
  const stats = useStats();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('title');

  const indexed = useMemo(
    () => library.tracks.map((t) => ({ t, key: searchKey(`${t.title} ${t.artist} ${t.album ?? ''}`) })),
    [library],
  );

  const list = useMemo(() => {
    const q = searchKey(query.trim());
    const words = q.split(/\s+/).filter(Boolean);
    const hits = words.length ? indexed.filter(({ key }) => words.every((w) => key.includes(w))) : indexed;
    const out = hits.map((h) => h.t);
    const byTitle = (a: Track, b: Track) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (sort === 'title') out.sort(byTitle);
    if (sort === 'artist') out.sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || byTitle(a, b));
    if (sort === 'plays') out.sort((a, b) => (stats[b.id]?.plays ?? 0) - (stats[a.id]?.plays ?? 0) || byTitle(a, b));
    return out;
  }, [indexed, query, sort, stats]);

  const onPress = useCallback(
    (track: Track) => playTracks(list.map((t) => t.id), { startId: track.id, label: 'Songs' }),
    [list],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.head}>
        <Text style={styles.h1}>Songs</Text>
        <View style={styles.search}>
          <Ionicons name="search" size={16} color={colors.textFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${library.tracks.length} songs`}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
        <View style={styles.chips}>
          {SORTS.map((s) => (
            <Pressable key={s.id} onPress={() => setSort(s.id)} style={[styles.chip, sort === s.id && styles.chipOn]}>
              <Text style={[styles.chipText, sort === s.id && styles.chipTextOn]}>{s.label}</Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable
            hitSlop={8}
            onPress={() => playTracks(list.map((t) => t.id), { shuffle: true, label: 'Songs' })}
          >
            <Ionicons name="shuffle" size={22} color={colors.accent} />
          </Pressable>
        </View>
      </View>
      <FlatList
        data={list}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <TrackRow track={item} onPress={onPress} />}
        getItemLayout={(_, i) => ({ length: TRACK_ROW_HEIGHT, offset: TRACK_ROW_HEIGHT * i, index: i })}
        initialNumToRender={16}
        windowSize={11}
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 170 }}
        ListEmptyComponent={<Text style={styles.empty}>No songs match “{query}”.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { paddingHorizontal: 16, paddingBottom: 8 },
  h1: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5, marginBottom: 12 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    height: 40,
  },
  input: { flex: 1, color: colors.text, fontSize: 15 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: colors.surface },
  chipOn: { backgroundColor: colors.accent },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: colors.accentInk },
  empty: { color: colors.textDim, textAlign: 'center', marginTop: 40 },
});

