import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { downloadTracks, downloadsSupported, removeDownload, useDownloadEntry } from '../lib/downloads';
import { formatTime } from '../lib/format';
import { useConfig, useOffline } from '../lib/library';
import type { Track } from '../lib/types';
import { playNext, useCurrentId, usePlayer } from '../player/controller';
import { Artwork } from './Artwork';
import { colors } from './theme';

export const TRACK_ROW_HEIGHT = 60;

type Props = { track: Track; onPress: (track: Track) => void; detail?: string };

function TrackRowInner({ track, onPress, detail }: Props) {
  const download = useDownloadEntry(track.id);
  const config = useConfig();
  const offline = useOffline();
  const currentId = useCurrentId();
  const playing = usePlayer((s) => s.playing);
  const isCurrent = currentId === track.id;
  const downloaded = download?.state === 'done';
  const available = downloaded || (!!track.audioKey && !!config && !offline);

  const showActions = () => {
    const options: { label: string; run: () => void; destructive?: boolean }[] = [];
    if (available) options.push({ label: 'Play next', run: () => playNext(track.id) });
    if (downloadsSupported && track.audioKey && !downloaded)
      options.push({ label: 'Download', run: () => downloadTracks([track.id]) });
    if (downloaded) options.push({ label: 'Remove download', run: () => removeDownload(track.id), destructive: true });
    if (!options.length) {
      Alert.alert(track.title, 'This song has no audio uploaded yet.');
      return;
    }
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: track.title,
          message: track.artist,
          options: [...options.map((o) => o.label), 'Cancel'],
          cancelButtonIndex: options.length,
          destructiveButtonIndex: options.findIndex((o) => o.destructive),
          userInterfaceStyle: 'dark',
        },
        (i) => options[i]?.run(),
      );
    } else {
      Alert.alert(track.title, track.artist, [
        ...options.map((o) => ({ text: o.label, onPress: o.run, style: o.destructive ? ('destructive' as const) : undefined })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };

  return (
    <Pressable
      onPress={() => onPress(track)}
      onLongPress={showActions}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Artwork trackId={track.id} size={44} rounded={6} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.title, isCurrent && styles.current, !available && styles.unavailable]}>
          {track.title}
        </Text>
        <Text numberOfLines={1} style={[styles.artist, !available && styles.unavailable]}>
          {detail ?? track.artist}
        </Text>
      </View>
      <View style={styles.right}>
        {isCurrent && playing ? <Ionicons name="volume-medium" size={16} color={colors.accent} /> : null}
        {download?.state === 'downloading' || download?.state === 'queued' ? (
          <Text style={styles.meta}>{Math.round((download.progress ?? 0) * 100)}%</Text>
        ) : null}
        {downloaded ? <Ionicons name="arrow-down-circle" size={16} color={colors.accent} /> : null}
        {download?.state === 'error' ? <Ionicons name="alert-circle" size={16} color={colors.danger} /> : null}
        <Text style={styles.meta}>{formatTime(track.durationSec)}</Text>
        <Pressable hitSlop={10} onPress={showActions}>
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textFaint} />
        </Pressable>
      </View>
    </Pressable>
  );
}

export const TrackRow = memo(TrackRowInner);

const styles = StyleSheet.create({
  row: { height: TRACK_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
  pressed: { backgroundColor: colors.surface },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  current: { color: colors.accent },
  artist: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  unavailable: { color: colors.textFaint },
  right: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  meta: { color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
});

