import { Ionicons } from '@expo/vector-icons';
import type { SessionMeta } from '@pocket/protocol';
import * as Haptics from '../../src/haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { alert } from '../../src/alert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../../src/components/Avatar';
import { ClaudeAvatar } from '../../src/components/ClaudeAvatar';
import { makeConversations, makeNotes, OWN, type FakeConversation } from '../../src/content/fake';
import { connectionBanner, isActiveNow } from '../../src/direct';
import { useScreenActive } from '../../src/hooks';
import { personaFor } from '../../src/persona';
import { relativeTime } from '../../src/format';
import { useChatSelector, useSession } from '../../src/session';
import { useLastOpened } from '../../src/state/unread';
import { colors } from '../../src/theme';

type Row = { kind: 'claude'; session: SessionMeta } | { kind: 'fake'; conversation: FakeConversation } | { kind: 'hidden-toggle'; count: number };

function Subtitle({ text, bold, time }: { text: string; bold: boolean; time: string }) {
  return (
    <View style={styles.subRow}>
      <Text style={[styles.sub, styles.subText, bold && styles.subBold]} numberOfLines={1}>
        {text}
      </Text>
      <Text style={[styles.sub, styles.subTime, bold && styles.subBold]}> · {time}</Text>
    </View>
  );
}

function ClaudeRow({ session, now, active, onPress, onLongPress }: { session: SessionMeta; now: number; active: boolean; onPress: () => void; onLongPress: () => void }) {
  const lastOpened = useLastOpened(session.sessionId);
  const unread = session.updatedAt > lastOpened;
  const waiting = session.state === 'waiting_permission';
  const typing = session.state === 'running';
  const text = waiting ? 'Waiting for approval' : typing ? 'Typing…' : session.lastText?.replace(/\s+/g, ' ') || 'No messages yet';
  const bold = waiting || unread;
  const persona = personaFor(session.sessionId);
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [styles.row, session.hidden && styles.rowHidden, pressed && { backgroundColor: colors.surface }]}>
      <ClaudeAvatar size={56} active={active} persona={persona} />
      <View style={styles.rowBody}>
        <Text style={[styles.name, bold && styles.nameBold]} numberOfLines={1}>
          {persona.username}
        </Text>
        <Subtitle text={text} bold={bold} time={relativeTime(session.updatedAt, now)} />
      </View>
      {unread || waiting ? <View style={[styles.dot, waiting && { backgroundColor: colors.warn }]} /> : <Ionicons name="camera-outline" size={24} color={colors.textMuted} />}
    </Pressable>
  );
}

function FakeRow({ conversation, onPress }: { conversation: FakeConversation; onPress: () => void }) {
  const mins = conversation.minutesAgo;
  const time = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
      <View>
        <Avatar uri={conversation.person.avatar} size={56} />
        {conversation.active ? <View style={styles.activeDot} /> : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.name, conversation.unread && styles.nameBold]} numberOfLines={1}>
          {conversation.name}
        </Text>
        <Subtitle text={conversation.preview} bold={conversation.unread} time={time} />
      </View>
      {conversation.unread ? <View style={styles.dot} /> : <Ionicons name="camera-outline" size={24} color={colors.textMuted} />}
    </Pressable>
  );
}

function Notes() {
  const notes = useMemo(() => makeNotes(), []);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.notes}>
      <View style={styles.note}>
        <View style={styles.noteBubble}>
          <Text style={[styles.noteText, { color: colors.textMuted }]}>Note…</Text>
        </View>
        <Avatar uri={OWN.avatar} size={64} />
        <Text style={styles.noteName}>Your note</Text>
      </View>
      {notes.map((n) => (
        <View key={n.id} style={styles.note}>
          <View style={styles.noteBubble}>
            <Text style={styles.noteText} numberOfLines={2}>
              {n.text}
            </Text>
          </View>
          <Avatar uri={n.person.avatar} size={64} />
          <Text style={styles.noteName} numberOfLines={1}>
            {n.person.username}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

export default function DirectInbox() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client } = useSession();
  const sessions = useChatSelector((s) => s.sessions);
  const host = useChatSelector((s) => s.host);
  const computers = useChatSelector((s) => s.computers);
  const lastError = useChatSelector((s) => s.lastError);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const fakes = useMemo(() => makeConversations(), []);

  // "5 min ago" ticks only while the list is on screen: under an open chat or with the app away it would wake the
  // phone for nothing.
  const screenActive = useScreenActive();
  useEffect(() => {
    if (!screenActive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [screenActive]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    client?.refresh();
    setTimeout(() => setRefreshing(false), 900);
  }, [client]);

  const create = useCallback(async () => {
    if (!client || creating) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCreating(true);
    try {
      const id = await client.createSession();
      router.push({ pathname: '/direct/[id]', params: { id } });
    } catch {
    } finally {
      setCreating(false);
    }
  }, [client, creating, router]);

  const q = query.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    const matching = sessions.filter((s) => !q || personaFor(s.sessionId).username.includes(q) || s.title.toLowerCase().includes(q) || (s.lastText ?? '').toLowerCase().includes(q));
    const hidden = matching.filter((s) => s.hidden);
    const claude: Row[] = [
      ...matching.filter((s) => !s.hidden).map((session): Row => ({ kind: 'claude', session })),
      ...(hidden.length ? [{ kind: 'hidden-toggle', count: hidden.length } as Row] : []),
      ...(showHidden ? hidden.map((session): Row => ({ kind: 'claude', session })) : []),
    ];
    const fake: Row[] = fakes
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.person.username.includes(q))
      .map((conversation) => ({ kind: 'fake', conversation }));
    return [...claude, ...fake];
  }, [sessions, fakes, q, showHidden]);

  const manage = useCallback(
    (session: SessionMeta) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const remove = () =>
        alert('Delete this chat?', 'The conversation is erased on the Mac too. This cannot be undone.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => client?.deleteSession(session.sessionId) },
        ]);
      alert(session.lastText?.replace(/\s+/g, ' ').slice(0, 60) || 'Chat', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: session.hidden ? 'Unhide' : 'Hide', onPress: () => client?.hideSession(session.sessionId, !session.hidden) },
        { text: 'Delete', style: 'destructive', onPress: remove },
      ]);
    },
    [client],
  );

  const banner = useChatSelector(connectionBanner);
  const active = useChatSelector(isActiveNow);

  const header = (
    <View>
      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      {q ? null : <Notes />}
      <View style={styles.sectionRow}>
        <Text style={styles.section}>Messages</Text>
        <Text style={styles.requests}>Requests</Text>
      </View>
      {host && !host.ready && host.reason ? <Text style={styles.notice}>{host.reason}</Text> : null}
      {host?.user && !host.user.owner && computers.length === 0 ? (
        <Pressable onPress={() => router.push('/direct/computers')} style={styles.setupCard}>
          <Ionicons name="laptop-outline" size={22} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.setupTitle}>Connect your computer</Text>
            <Text style={styles.setupHint}>Run PocketClipboard.exe on it and scan the code here: Claude then sees its screen and clipboard.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
      {lastError ? (
        <Pressable onPress={() => client?.clearError()}>
          <Text style={[styles.notice, { color: colors.danger }]}>{lastError}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={[styles.top, { paddingTop: insets.top, height: 52 + insets.top }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.handle}>
          <Text style={styles.handleText}>{OWN.username}</Text>
          <Ionicons name="chevron-down" size={16} color={colors.text} />
        </View>
        <Pressable onPress={create} hitSlop={12} accessibilityLabel="New message">
          {creating ? <ActivityIndicator color={colors.text} /> : <Ionicons name="create-outline" size={26} color={colors.text} />}
        </Pressable>
      </View>
      {banner ? (
        <View style={styles.banner}>
          <Ionicons name="cloud-offline-outline" size={14} color={colors.warn} />
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'claude' ? r.session.sessionId : r.kind === 'fake' ? r.conversation.id : 'hidden-toggle')}
        ListHeaderComponent={header}
        renderItem={({ item }) =>
          item.kind === 'claude' ? (
            <ClaudeRow
              session={item.session}
              now={now}
              active={active}
              onPress={() => router.push({ pathname: '/direct/[id]', params: { id: item.session.sessionId } })}
              onLongPress={() => manage(item.session)}
            />
          ) : item.kind === 'hidden-toggle' ? (
            <Pressable onPress={() => setShowHidden((v) => !v)} style={styles.hiddenToggle}>
              <Ionicons name={showHidden ? 'eye-off-outline' : 'eye-outline'} size={16} color={colors.textMuted} />
              <Text style={styles.hiddenText}>{showHidden ? 'Hide hidden chats' : `Hidden chats (${item.count})`}</Text>
            </Pressable>
          ) : (
            <FakeRow conversation={item.conversation} onPress={() => router.push({ pathname: '/direct/[id]', params: { id: item.conversation.id } })} />
          )
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.text} colors={[colors.text]} progressBackgroundColor={colors.surfaceHi} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  setupCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  setupTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  setupHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  root: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, gap: 16 },
  handle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  handleText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 28, backgroundColor: colors.surfaceHi },
  bannerText: { color: colors.warn, fontSize: 12, fontWeight: '600' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 40, marginHorizontal: 16, marginTop: 6, paddingHorizontal: 12, borderRadius: 20, backgroundColor: colors.surfaceHi },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, padding: 0 },
  notes: { paddingHorizontal: 12, paddingTop: 22, paddingBottom: 6, gap: 8 },
  note: { width: 84, alignItems: 'center', gap: 4 },
  noteBubble: { position: 'absolute', top: -16, zIndex: 1, maxWidth: 82, minHeight: 28, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, backgroundColor: colors.surfaceHi, justifyContent: 'center' },
  noteText: { color: colors.text, fontSize: 11, textAlign: 'center' },
  noteName: { color: colors.textMuted, fontSize: 12, maxWidth: 80 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  section: { color: colors.text, fontSize: 16, fontWeight: '700' },
  requests: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  notice: { color: colors.warn, fontSize: 12.5, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: 76 },
  rowBody: { flex: 1, gap: 2 },
  rowHidden: { opacity: 0.55 },
  hiddenToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  hiddenText: { color: colors.textMuted, fontSize: 13.5, fontWeight: '600' },
  name: { color: colors.text, fontSize: 14 },
  nameBold: { fontWeight: '600' },
  subRow: { flexDirection: 'row' },
  sub: { color: colors.textMuted, fontSize: 14 },
  subText: { flexShrink: 1 },
  subTime: { flexShrink: 0 },
  subBold: { color: colors.text, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginRight: 4 },
  activeDot: { position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.ok, borderWidth: 3, borderColor: colors.bg },
});
