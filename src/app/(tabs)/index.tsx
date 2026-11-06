import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDownloadEntries } from '../../lib/downloads';
import { formatHours } from '../../lib/format';
import { useConfig, useLibrary, useSyncError, useTracksById } from '../../lib/library';
import { useStats } from '../../lib/stats';
import { playTracks, usePlayer } from '../../player/controller';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { TrackRow } from '../../ui/TrackRow';
import { colors, radius } from '../../ui/theme';

export default function Home() {
  const insets = useSafeAreaInsets();
  const library = useLibrary();
  const tracks = useTracksById();
  const config = useConfig();
  const syncError = useSyncError();
  const downloads = useDownloadEntries();
  const stats = useStats();
  const error = usePlayer((s) => s.error);

  const withAudio = library.tracks.filter((t) => t.audioKey).length;
  const downloaded = Object.values(downloads).filter((d) => d.state === 'done').length;
  const allIds = useMemo(() => library.tracks.map((t) => t.id), [library]);

  const mostPlayed = useMemo(
    () =>
      Object.entries(stats)
        .filter(([id, s]) => s.plays > 0 && tracks[id])
        .sort((a, b) => b[1].plays - a[1].plays)
        .slice(0, 8)
        .map(([id, s]) => ({ track: tracks[id], plays: s.plays })),
    [stats, tracks],
  );

  let status = `${withAudio} of ${library.tracks.length} songs ready${downloaded ? ` · ${downloaded} offline` : ''}`;
  if (!config) status = `${library.tracks.length} songs · music server not set up yet`;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 170 }}
    >
      <View style={styles.header}>
        <Text style={styles.h1}>Prag Music</Text>
        <Text style={styles.status}>{status}</Text>
        {syncError ? <Text style={styles.warn}>{syncError}</Text> : null}
        {error ? <Text style={styles.warn}>{error}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Button
          label="Shuffle everything"
          icon="shuffle"
          kind="primary"
          onPress={() => playTracks(allIds, { shuffle: true, label: 'Everything' })}
          style={{ flex: 1 }}
        />
      </View>

      <Text style={styles.section}>Playlists</Text>
      {library.playlists.map((p) => {
        const secs = p.trackIds.reduce((sum, id) => sum + (tracks[id]?.durationSec ?? 0), 0);
        return (
          <Pressable
            key={p.id}
            onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: p.id } })}
            style={({ pressed }) => [styles.playlist, pressed && { backgroundColor: colors.surfaceHigh }]}
          >
            <View style={styles.collage}>
              {p.trackIds.slice(0, 4).map((id, i) => (
                <Artwork key={`${i}-${id}`} trackId={id} size={36} rounded={0} />
              ))}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.playlistName}>{p.name}</Text>
              <Text style={styles.playlistMeta}>
                {p.trackIds.length} songs · {formatHours(secs)}
              </Text>
            </View>
            <Pressable hitSlop={10} onPress={() => playTracks(p.trackIds, { shuffle: true, label: p.name })}>
              <Ionicons name="shuffle" size={22} color={colors.accent} />
            </Pressable>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </Pressable>
        );
      })}

      {mostPlayed.length ? (
        <>
          <Text style={styles.section}>Most played</Text>
          {mostPlayed.map(({ track, plays }) => (
            <TrackRow
              key={track.id}
              track={track}
              detail={`${track.artist} · ${plays} ${plays === 1 ? 'play' : 'plays'}`}
              onPress={(t) => playTracks(mostPlayed.map((m) => m.track.id), { startId: t.id, label: 'Most played' })}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 18 },
  h1: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  status: { color: colors.textDim, fontSize: 14, marginTop: 6 },
  warn: { color: colors.danger, fontSize: 13, marginTop: 6 },
  actions: { flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 8 },
  section: { color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: 20, marginTop: 24, marginBottom: 10 },
  playlist: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 12,
    padding: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    marginBottom: 10,
  },
  collage: { width: 72, height: 72, flexDirection: 'row', flexWrap: 'wrap', borderRadius: radius.md, overflow: 'hidden' },
  playlistName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  playlistMeta: { color: colors.textDim, fontSize: 13, marginTop: 4 },
});

