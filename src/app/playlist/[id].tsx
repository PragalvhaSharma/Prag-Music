import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { downloadTracks, downloadsSupported, useDownloadEntries } from '../../lib/downloads';
import { formatBytes, formatHours } from '../../lib/format';
import { useConfig, usePlaylist, useTracksById } from '../../lib/library';
import type { Track } from '../../lib/types';
import { playTracks } from '../../player/controller';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { MiniPlayer } from '../../ui/MiniPlayer';
import { TRACK_ROW_HEIGHT, TrackRow } from '../../ui/TrackRow';
import { colors } from '../../ui/theme';

export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlist = usePlaylist(id);
  const tracksById = useTracksById();
  const downloads = useDownloadEntries();
  const config = useConfig();
  const insets = useSafeAreaInsets();

  const tracks = useMemo(
    () => (playlist?.trackIds ?? []).map((tid) => tracksById[tid]).filter((t): t is Track => !!t),
    [playlist, tracksById],
  );
  const ids = useMemo(() => tracks.map((t) => t.id), [tracks]);
  const unique = useMemo(() => [...new Map(tracks.map((t) => [t.id, t])).values()], [tracks]);
  const seconds = tracks.reduce((s, t) => s + t.durationSec, 0);
  const withAudio = unique.filter((t) => t.audioKey);
  const downloaded = unique.filter((t) => downloads[t.id]?.state === 'done').length;
  const remainingBytes = withAudio
    .filter((t) => downloads[t.id]?.state !== 'done')
    .reduce((s, t) => s + (t.bytes ?? 0), 0);

  const onPress = useCallback(
    (t: Track) => playTracks(ids, { startId: t.id, label: playlist?.name }),
    [ids, playlist],
  );

  const downloadAll = () => {
    if (!config) {
      Alert.alert('No music server', 'This build has no music server set up yet.');
      return;
    }
    if (!remainingBytes) {
      Alert.alert('All set', 'Every song with audio in this playlist is already downloaded.');
      return;
    }
    Alert.alert('Download playlist', `This saves ${formatBytes(remainingBytes)} to your phone for offline listening.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Download', onPress: () => downloadTracks(ids) },
    ]);
  };

  if (!playlist) {
    return (
      <View style={styles.root}>
        <Text style={styles.meta}>Playlist not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: playlist.name }} />
      <FlatList
        data={tracks}
        keyExtractor={(t, i) => `${i}-${t.id}`}
        renderItem={({ item }) => <TrackRow track={item} onPress={onPress} />}
        getItemLayout={(_, i) => ({ length: TRACK_ROW_HEIGHT, offset: TRACK_ROW_HEIGHT * i + HEADER, index: i })}
        initialNumToRender={14}
        contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.collage}>
              {ids.slice(0, 4).map((tid, i) => (
                <Artwork key={`${i}-${tid}`} trackId={tid} size={80} rounded={0} />
              ))}
            </View>
            <Text style={styles.title}>{playlist.name}</Text>
            <Text style={styles.meta}>
              {tracks.length} songs · {formatHours(seconds)} · {withAudio.length} with audio
              {downloadsSupported ? ` · ${downloaded} downloaded` : ''}
            </Text>
            <View style={styles.buttons}>
              <Button label="Play" icon="play" kind="primary" onPress={() => playTracks(ids, { shuffle: false, label: playlist.name })} style={{ flex: 1 }} />
              <Button label="Shuffle" icon="shuffle" onPress={() => playTracks(ids, { shuffle: true, label: playlist.name })} style={{ flex: 1 }} />
              {downloadsSupported ? <Button label="" icon="arrow-down" onPress={downloadAll} style={{ paddingHorizontal: 14 }} /> : null}
            </View>
          </View>
        }
      />
      <MiniPlayer style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 8 }} />
    </View>
  );
}

const HEADER = 290;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { height: HEADER, alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
  collage: { width: 160, height: 160, flexDirection: 'row', flexWrap: 'wrap', borderRadius: 14, overflow: 'hidden' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 14 },
  meta: { color: colors.textDim, fontSize: 13, marginTop: 4, textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14, alignSelf: 'stretch' },
});

