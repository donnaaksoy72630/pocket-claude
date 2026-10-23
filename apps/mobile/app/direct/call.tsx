import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PHASE_LABEL, useCall, useElapsed } from '../../src/call';
import { useCallPrefs } from '../../src/call-prefs';
import { ClaudeAvatar } from '../../src/components/ClaudeAvatar';
import { useAppActive } from '../../src/hooks';
import { personaFor } from '../../src/persona';
import { useChatSelector } from '../../src/session';
import { colors } from '../../src/theme';

/**
 * A voice call with the chat: talk, pause, hear the answer. Leaving the screen keeps the call going (green bar on
 * top); with the screen locked the iPhone shows it as a phone call.
 */
export default function CallScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = id ?? '';
  const call = useCall();
  const prefs = useCallPrefs();
  const persona = useMemo(() => personaFor(sessionId), [sessionId]);
  const brainOnline = useChatSelector((s) => s.brainOnline);
  const connection = useChatSelector((s) => s.connection);
  const appActive = useAppActive();
  const [speaker, setSpeaker] = useState(prefs.speaker);
  const { start } = call;
  const mine = call.active?.sessionId === sessionId;
  const snap = mine ? call.snapshot : null;
  const elapsed = useElapsed(mine ? call.active?.startedAt : undefined, appActive);

  useEffect(() => {
    if (Platform.OS !== 'web' && sessionId) start(sessionId);
  }, [sessionId, start]);

  // Hung up from the lock screen or a headset.
  useEffect(() => {
    if (snap?.phase === 'ended') {
      call.hangUp();
      if (router.canGoBack()) router.back();
    }
  }, [snap?.phase, call, router]);

  useEffect(() => {
    if (snap?.route) setSpeaker(snap.route === 'speaker');
  }, [snap?.route]);

  const phase = snap?.phase ?? 'starting';
  const speaking = phase === 'speaking';
  const muted = phase === 'muted';

  const hangUp = () => {
    call.hangUp();
    router.back();
  };

  const toggleSpeaker = () => {
    const next = !speaker;
    setSpeaker(next);
    call.setSpeaker(next);
  };

  const shareLog = () => {
    const log = call.log();
    if (log) void Share.share({ message: log }).catch(() => {});
  };

  // The phone's own connection first: without it the Mac looks offline too.
  const offline = phase === 'error' ? null : connection !== 'online' ? 'No connection, reconnecting…' : !brainOnline ? 'Mac offline' : null;
  const status = snap?.error ?? offline ?? PHASE_LABEL[phase];
  const line = speaking ? snap?.said : snap?.heard;
  const placeholder = phase === 'listening' ? 'Say something; a short pause sends it.' : phase === 'thinking' ? 'Claude is on it…' : ' ';
  const badges = [snap?.callKit ? 'Phone call' : null, snap?.echoCancellation ? 'Talk over it' : null, snap?.voiceName ? `Voice: ${snap.voiceName}` : null].filter(Boolean);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.top}>
        <ClaudeAvatar size={120} persona={persona} active={snap?.userSpeaking === true || phase === 'listening'} />
        <Text style={styles.name}>{persona.name}</Text>
        <Text style={styles.timer}>{elapsed}</Text>
        <Pressable onLongPress={shareLog} delayLongPress={600} hitSlop={8} accessibilityHint="Long press to send the call log">
          <Text style={[styles.status, phase === 'error' && { color: colors.danger }, phase === 'listening' && { color: colors.ok }]}>{status}</Text>
        </Pressable>
        {phase === 'error' && snap?.errorAction === 'settings' ? (
          <Pressable onPress={() => void Linking.openSettings()} style={styles.action} accessibilityRole="button">
            <Text style={styles.actionText}>Open Settings</Text>
          </Pressable>
        ) : null}
        {badges.length ? <Text style={styles.badges}>{badges.join(' · ')}</Text> : null}
      </View>

      <Pressable onPress={() => call.interrupt()} style={styles.transcript} disabled={!speaking}>
        <Text style={styles.line} numberOfLines={7}>
          {line || placeholder}
        </Text>
        {speaking ? <Text style={styles.hint}>{snap?.echoCancellation && prefs.bargeIn ? 'Tap or just talk to interrupt' : 'Tap to interrupt'}</Text> : null}
        {snap?.notice && phase !== 'error' ? <Text style={[styles.hint, styles.notice]}>{snap.notice}</Text> : null}
      </Pressable>

      <View style={styles.controls}>
        <Pressable
          onPress={() => call.setMuted(!muted)}
          style={[styles.round, muted && styles.roundOn]}
          accessibilityLabel={muted ? 'Unmute' : 'Mute'}
          disabled={phase === 'error'}
        >
          <Ionicons name={muted ? 'mic-off' : 'mic'} size={28} color={muted ? colors.bg : colors.text} />
        </Pressable>
        <Pressable onPress={toggleSpeaker} style={[styles.round, speaker && styles.roundOn]} accessibilityLabel={speaker ? 'Earpiece' : 'Speaker'} disabled={phase === 'error'}>
          <Ionicons name={speaker ? 'volume-high' : 'volume-medium-outline'} size={28} color={speaker ? colors.bg : colors.text} />
        </Pressable>
        <Pressable onPress={hangUp} style={[styles.round, styles.hangUp]} accessibilityLabel="End call">
          <Ionicons name="call" size={30} color="#FFFFFF" style={{ transform: [{ rotate: '135deg' }] }} />
        </Pressable>
        <Pressable onPress={() => router.back()} style={styles.round} accessibilityLabel="Back to chat, the call goes on">
          <Ionicons name="chatbubble-ellipses-outline" size={26} color={colors.text} />
        </Pressable>
      </View>
      {Platform.OS === 'web' ? <Text style={styles.hint}>Calls work in the phone app.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24 },
  top: { alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 26, fontWeight: '700', marginTop: 12 },
  timer: { color: colors.textMuted, fontSize: 15, fontVariant: ['tabular-nums'] },
  status: { color: colors.textMuted, fontSize: 15, marginTop: 4, textAlign: 'center' },
  badges: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  action: { marginTop: 4, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.surface },
  actionText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  transcript: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 24 },
  line: { color: colors.text, fontSize: 18, lineHeight: 26, textAlign: 'center' },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: 12, textAlign: 'center' },
  notice: { color: colors.warn },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  round: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  roundOn: { backgroundColor: colors.text },
  hangUp: { backgroundColor: colors.danger, width: 76, height: 76, borderRadius: 38 },
});
