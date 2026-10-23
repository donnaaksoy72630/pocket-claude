import { Ionicons } from '@expo/vector-icons';
import type { PermissionRequest } from '@pocket/client-core';
import type { SessionState } from '@pocket/protocol';
import { usePathname, useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadCallPrefs } from './call-prefs';
import { useAppActive } from './hooks';
import { personaFor } from './persona';
import { useSession } from './session';
import { callLanguageFor, createSpeechEngine } from './speech-engine';
import { colors } from './theme';
import { showsInBackground, VoiceCall, type CallPhase, type CallSnapshot } from './voice';

interface ActiveCall {
  sessionId: string;
  startedAt: number;
}

interface CallContextValue {
  active: ActiveCall | null;
  snapshot: CallSnapshot | null;
  /** Starts a call with the chat, or does nothing when that call is already on. */
  start: (sessionId: string) => void;
  hangUp: () => void;
  setMuted: (muted: boolean) => void;
  setSpeaker: (on: boolean) => void;
  interrupt: () => void;
  log: () => string;
}

const CallContext = createContext<CallContextValue | null>(null);
/** A call is on: a boolean of its own, so screens that only pause media do not re-render on every word of the call. */
const CallOnContext = createContext(false);

export const PHASE_LABEL: Record<CallPhase, string> = {
  starting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  confirming: 'Say “yes” or “no”',
  muted: 'Muted',
  held: 'On hold',
  ended: 'Call ended',
  error: 'Call failed',
};

/**
 * Owns the voice call, so it survives leaving the call screen: the chat stays open with a green bar on top, and the
 * call keeps going with the screen locked. The call follows the chat through the client directly, without React.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { client } = useSession();
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [snapshot, setSnapshot] = useState<CallSnapshot | null>(null);
  // With the screen locked the call goes on and nothing is on screen: only phase changes and errors re-render, the
  // newest snapshot shows when the app is back in front.
  const latest = useRef<CallSnapshot | null>(null);
  const shown = useRef<CallSnapshot | null>(null);
  const show = useCallback((next: CallSnapshot | null) => {
    latest.current = next;
    // Only a known background holds updates back: at launch iOS reports 'unknown', and a missed change to 'active'
    // must not leave the call screen without its live text.
    if (next !== null && AppState.currentState === 'background' && !showsInBackground(shown.current, next)) return;
    shown.current = next;
    setSnapshot(next);
  }, []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'background' && latest.current !== shown.current) show(latest.current);
    });
    return () => sub.remove();
  }, [show]);
  const current = useRef<{ sessionId: string; call: VoiceCall; unsubscribe: () => void } | null>(null);
  const token = useRef(0);

  const release = useCallback(() => {
    const running = current.current;
    current.current = null;
    running?.unsubscribe();
    running?.call.end();
  }, []);

  const start = useCallback(
    (sessionId: string) => {
      if (!client || Platform.OS === 'web') return;
      if (current.current?.sessionId === sessionId) return;
      release();
      const mine = ++token.current;
      setActive({ sessionId, startedAt: Date.now() });
      show(null);
      void loadCallPrefs().then(async (prefs) => {
        const language = await callLanguageFor(prefs.language, client.getState().threads);
        if (mine !== token.current) return;
        const state = client.getState();
        const call = new VoiceCall({
          engine: createSpeechEngine(),
          send: (text) => client.send(sessionId, text, undefined, { voice: true }),
          respondPermission: (requestId, decision) => client.respondPermission(requestId, decision),
          onChange: show,
          language,
          voice: prefs.voice,
          callerName: personaFor(sessionId).name,
          speaker: prefs.speaker,
          useCallKit: prefs.callKit,
          bargeIn: prefs.bargeIn,
          initialThread: state.threads[sessionId] ?? [],
        });
        const forSession = (list: readonly PermissionRequest[]) => list.filter((p) => p.sessionId === sessionId);
        let thread = state.threads[sessionId];
        let sessionState: SessionState | undefined = state.sessions.find((s) => s.sessionId === sessionId)?.state;
        let permissions = state.permissions;
        const unsubscribe = client.subscribe((s) => {
          const nextThread = s.threads[sessionId];
          const nextState = s.sessions.find((x) => x.sessionId === sessionId)?.state;
          if (nextThread !== thread || nextState !== sessionState) {
            thread = nextThread;
            sessionState = nextState;
            call.onThread(thread ?? [], sessionState);
          }
          if (s.permissions !== permissions) {
            permissions = s.permissions;
            call.onPermissions(forSession(permissions));
          }
        });
        current.current = { sessionId, call, unsubscribe };
        show(call.snapshot());
        void call.start();
        call.onPermissions(forSession(permissions));
      });
    },
    [client, release, show],
  );

  const hangUp = useCallback(() => {
    token.current++;
    release();
    setActive(null);
    show(null);
  }, [release, show]);

  // Ended from the lock screen, a headset or by a failure: stop following the chat, keep the last state to show.
  const over = snapshot?.phase === 'ended' || snapshot?.phase === 'error';
  useEffect(() => {
    if (!over || !current.current) return;
    const ended = current.current;
    current.current = null;
    ended.unsubscribe();
  }, [over]);

  // Unpaired or reconnected with new credentials: the call belongs to the old client.
  useEffect(() => () => hangUp(), [client, hangUp]);

  const value = useMemo<CallContextValue>(
    () => ({
      active,
      snapshot,
      start,
      hangUp,
      setMuted: (muted) => current.current?.call.setMuted(muted),
      setSpeaker: (on) => current.current?.call.setSpeaker(on),
      interrupt: () => current.current?.call.interrupt(),
      log: () => current.current?.call.log() ?? '',
    }),
    [active, snapshot, start, hangUp],
  );

  const on = active !== null && snapshot?.phase !== 'ended' && snapshot?.phase !== 'error';
  return (
    <CallContext.Provider value={value}>
      <CallOnContext.Provider value={on}>{children}</CallOnContext.Provider>
    </CallContext.Provider>
  );
}

/** True while a call is on, whatever screen shows; changes only when a call starts or ends. */
export function useCallOn(): boolean {
  return useContext(CallOnContext);
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('CallProvider missing');
  return ctx;
}

/** Seconds since `startedAt`, ticking only while shown and the app is in front. */
export function useElapsed(startedAt: number | undefined, enabled: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, startedAt]);
  const seconds = startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The green bar over the app while a call goes on and its screen is closed; tapping it returns to the call. */
export function CallBar() {
  const { active, snapshot } = useCall();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const appActive = useAppActive();
  const onCallScreen = pathname === '/direct/call';
  const visible = active !== null && snapshot !== null && snapshot.phase !== 'ended' && snapshot.phase !== 'error' && !onCallScreen;
  const elapsed = useElapsed(active?.startedAt, visible && appActive);
  if (!visible || !active || !snapshot) return null;
  const name = personaFor(active.sessionId).name;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/direct/call', params: { id: active.sessionId } })}
      style={[styles.bar, { top: insets.top + 4 }]}
      accessibilityLabel={`Return to the call with ${name}`}
    >
      <Ionicons name="call" size={14} color="#FFFFFF" />
      <Text style={styles.text} numberOfLines={1}>
        {name} · {PHASE_LABEL[snapshot.phase]} · {elapsed}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '80%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.ok,
    zIndex: 100,
  },
  text: { color: '#FFFFFF', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
