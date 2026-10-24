import { Ionicons } from '@expo/vector-icons';
import { MAC_DEVICE_ID, type Computer, type Project } from '@pocket/protocol';
import * as Haptics from '../../src/haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { alert } from '../../src/alert';
import { QrCode } from '../../src/components/QrCode';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScreenActive } from '../../src/hooks';
import { useChatState, useSession } from '../../src/session';
import { colors, mono } from '../../src/theme';

function osIcon(os: string | undefined): keyof typeof Ionicons.glyphMap {
  if (!os) return 'desktop-outline';
  if (/darwin|mac/i.test(os)) return 'laptop-outline';
  if (/linux/i.test(os)) return 'terminal-outline';
  return 'desktop-outline';
}

function osLabel(os: string | undefined): string {
  if (!os) return '';
  if (/^win32/i.test(os)) return 'Windows';
  if (/^darwin/i.test(os)) return 'macOS';
  if (/^linux/i.test(os)) return 'Linux';
  return os;
}

function ComputerRow({ c, current, onPick, onRemove }: { c: Computer; current: boolean; onPick: () => void; onRemove: () => void }) {
  const folder = c.workspaces[0];
  return (
    <Pressable onPress={onPick} onLongPress={onRemove} style={({ pressed }) => [styles.row, current && styles.rowOn, pressed && { opacity: 0.85 }]}>
      <View style={styles.icon}>
        <Ionicons name={osIcon(c.os)} size={22} color={colors.text} />
        <View style={[styles.dot, { backgroundColor: c.online ? colors.ok : colors.textMuted }]} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.name} numberOfLines={1}>
          {c.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[c.online ? 'Online' : 'Offline', osLabel(c.os)].filter(Boolean).join(' · ')}
        </Text>
        {folder ? (
          <Text style={styles.folder} numberOfLines={1} ellipsizeMode="head">
            {folder}
            {c.workspaces.length > 1 ? `  +${c.workspaces.length - 1}` : ''}
          </Text>
        ) : null}
      </View>
      {current ? <Ionicons name="checkmark-circle" size={24} color={colors.accent} /> : <View style={styles.radio} />}
    </Pressable>
  );
}

function ProjectRow({
  project,
  current,
  onPick,
  onOpen,
  defaultLabel = 'Whatever is open in VS Code',
}: {
  project: Project | null;
  current: boolean;
  onPick: () => void;
  onOpen?: () => void;
  defaultLabel?: string;
}) {
  return (
    <Pressable onPress={onPick} style={({ pressed }) => [styles.project, current && styles.projectOn, pressed && { opacity: 0.85 }]}>
      <Ionicons name={project ? (project.open ? 'folder-open' : 'folder-outline') : 'albums-outline'} size={18} color={current ? colors.accent : colors.textDim} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.projectName, current && { color: colors.accent }]} numberOfLines={1}>
          {project ? project.name : defaultLabel}
        </Text>
        {project ? (
          <Text style={styles.folder} numberOfLines={1} ellipsizeMode="head">
            {project.path}
          </Text>
        ) : null}
      </View>
      {project && !project.open && onOpen ? (
        <Pressable onPress={onOpen} hitSlop={8} style={styles.openBtn} accessibilityLabel={`Open ${project.name} in VS Code`}>
          <Text style={styles.openText}>Open</Text>
        </Pressable>
      ) : project?.open ? (
        <Text style={styles.openBadge}>open</Text>
      ) : null}
    </Pressable>
  );
}

function PairingCard({ code, safetyNumber, expiresAt, uri, onCancel }: { code: string; safetyNumber: string; expiresAt: number; uri?: string; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  const link = uri ?? code;
  const share = () => void Share.share({ message: link }).catch(() => {});
  return (
    <View style={styles.pairCard}>
      <Text style={styles.pairTitle}>Add a computer</Text>
      <Text style={styles.step}>1. On the PC run PocketClipboard.exe (it installs itself and starts with Windows).</Text>
      <Text style={styles.step}>2. Paste this link into it, or let it read the QR code with the webcam:</Text>
      {uri ? (
        <View style={styles.qrWrap}>
          <QrCode value={uri} size={168} />
        </View>
      ) : null}
      <Text selectable style={styles.code} numberOfLines={1} adjustsFontSizeToFit>
        {code}
      </Text>
      <Pressable onPress={share} style={styles.shareRow} hitSlop={8}>
        <Ionicons name="share-outline" size={18} color={colors.text} />
        <Text style={styles.shareText}>Send the link to the PC</Text>
      </Pressable>
      <Text style={styles.step}>3. The PC shows this safety number; it should match:</Text>
      <Text selectable style={styles.safety}>
        {safetyNumber}
      </Text>
      <View style={styles.pairFoot}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.wait}>{left > 0 ? `Waiting for the computer · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Code expired'}</Text>
        <Pressable onPress={onCancel} hitSlop={8}>
          <Text style={styles.cancel}>{left > 0 ? 'Cancel' : 'Close'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ComputersScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const { client } = useSession();
  const state = useChatState();
  const active = useScreenActive();
  const [requested, setRequested] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (active) client?.loadComputers();
  }, [active, client]);

  useEffect(() => () => client?.clearPairing(), [client]);

  useEffect(() => {
    if (requested && !state.pairing && state.computers.length > 0) setRequested(false);
  }, [requested, state.pairing, state.computers.length]);

  const session = sessionId ? state.sessions.find((s) => s.sessionId === sessionId) : undefined;
  const macOnline = state.connection === 'online' && state.brainOnline;
  const hasTools = (c: Computer) => !c.capabilities || c.capabilities.includes('tools');
  const toolComputers = state.computers.filter(hasTools);
  const clipboardComputers = state.computers.filter((c) => c.capabilities?.includes('clipboard'));
  // Everyone can work on the Mac: the owner anywhere, invited people in their own folder there. Older chats of invited
  // people without a choice run on their first tools computer, as the Mac decides.
  const owner = state.host?.user?.owner !== false;
  const chosen = session?.executorId;
  const workOn =
    chosen && toolComputers.some((c) => c.deviceId === chosen) ? chosen : chosen === MAC_DEVICE_ID || owner || toolComputers.length === 0 ? MAC_DEVICE_ID : toolComputers[0]!.deviceId;
  const currentProject = session?.project ?? null;
  const sameProject = (p: Project) => currentProject !== null && currentProject.toLowerCase() === p.path.toLowerCase();
  const allMacProjects = state.mac?.projects ?? [];
  const macProjects = showAll ? allMacProjects : allMacProjects.filter((p, i) => i < 6 || sameProject(p));

  const pickWorkspace = (deviceId: string, project: Project | null) => {
    void Haptics.selectionAsync();
    client?.selectComputer(deviceId, sessionId, project ? project.path : null);
  };

  const pickClipboard = (c: Computer) => {
    void Haptics.selectionAsync();
    client?.selectComputer(c.deviceId);
  };

  const openInVsCode = (c: Computer, project: Project) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    client?.openProject(c.deviceId, project.path);
    if (sessionId) client?.selectComputer(c.deviceId, sessionId, project.path);
  };

  const remove = (c: Computer) =>
    alert(`Remove ${c.name}?`, 'It is unpaired. To use it again, pair it with a new code.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => client?.removeComputer(c.deviceId) },
    ]);

  const add = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRequested(true);
    client?.pairComputer();
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top, height: 52 + insets.top }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Close">
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Computers</Text>
          <Text style={styles.subtitle}>{session ? 'Where this chat works, and whose clipboard to use' : 'Clipboard and paired computers'}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {!macOnline ? <Text style={styles.notice}>The Mac is offline, changes apply when it is back.</Text> : null}

        <Text style={styles.section}>PC clipboard</Text>
        {clipboardComputers.length === 0 ? (
          <Text style={styles.empty}>No computer shares its clipboard yet. Add one below and run PocketClipboard on it.</Text>
        ) : null}
        {clipboardComputers.map((c) => (
          <ComputerRow key={c.deviceId} c={c} current={c.deviceId === state.activeComputer} onPick={() => pickClipboard(c)} onRemove={() => remove(c)} />
        ))}
        {session ? (
          <View style={styles.projects}>
            <Text style={styles.section}>This chat works on</Text>
            <>
                <View style={[styles.row, workOn === MAC_DEVICE_ID && styles.rowOn]}>
                  <View style={styles.icon}>
                    <Ionicons name="laptop-outline" size={22} color={colors.text} />
                    <View style={[styles.dot, { backgroundColor: macOnline ? colors.ok : colors.textMuted }]} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name}>{state.mac?.name ?? 'Mac'}</Text>
                    <Text style={styles.meta}>{owner ? 'Claude works here with its own tools' : 'Your own folder on the Mac, apart from everyone else'}</Text>
                  </View>
                </View>
                <ProjectRow
                  project={null}
                  defaultLabel={owner ? 'pocket-workspace (default)' : "This chat's own folder"}
                  current={workOn === MAC_DEVICE_ID && currentProject === null}
                  onPick={() => pickWorkspace(MAC_DEVICE_ID, null)}
                />
                {macProjects.map((p) => (
                  <ProjectRow key={p.path} project={p} current={workOn === MAC_DEVICE_ID && sameProject(p)} onPick={() => pickWorkspace(MAC_DEVICE_ID, p)} />
                ))}
                {allMacProjects.length > macProjects.length || showAll ? (
                  <Pressable onPress={() => setShowAll((v) => !v)} hitSlop={6}>
                    <Text style={styles.more}>{showAll ? 'Show fewer' : `Show all ${allMacProjects.length} projects`}</Text>
                  </Pressable>
                ) : null}
            </>

            {toolComputers.map((c) => (
              <View key={c.deviceId} style={styles.projects}>
                <ComputerRow c={c} current={workOn === c.deviceId} onPick={() => pickWorkspace(c.deviceId, null)} onRemove={() => remove(c)} />
                {workOn === c.deviceId
                  ? (c.projects ?? []).map((p) => (
                      <ProjectRow
                        key={p.path}
                        project={p}
                        current={sameProject(p)}
                        onPick={() => pickWorkspace(c.deviceId, p)}
                        onOpen={c.online ? () => openInVsCode(c, p) : undefined}
                      />
                    ))
                  : null}
              </View>
            ))}
          </View>
        ) : null}

        {state.computers.length > 0 ? <Text style={styles.hint}>Long-press a computer to remove it.</Text> : null}

        {state.pairing ? (
          <PairingCard {...state.pairing} onCancel={() => client?.clearPairing()} />
        ) : (
          <Pressable onPress={add} disabled={!macOnline || requested} style={({ pressed }) => [styles.add, (!macOnline || requested) && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
            {requested ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="add-circle-outline" size={20} color={colors.accent} />}
            <Text style={styles.addText}>Add a computer</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  content: { paddingHorizontal: 14, paddingTop: 8, gap: 10 },
  notice: { color: colors.warn, fontSize: 13 },
  empty: { color: colors.textMuted, fontSize: 14, paddingVertical: 8 },
  hint: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'transparent' },
  rowOn: { borderColor: colors.accent },
  icon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.surfaceHi, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.surface },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12 },
  folder: { color: colors.textMuted, fontSize: 11.5, fontFamily: mono },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.borderHi },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 14, backgroundColor: colors.accentSoft, marginTop: 6 },
  addText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  projects: { gap: 6, marginTop: 4 },
  more: { color: colors.accent, fontSize: 13.5, fontWeight: '600', paddingVertical: 6, paddingHorizontal: 4 },
  section: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 6, marginBottom: 2 },
  project: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'transparent' },
  projectOn: { borderColor: colors.accent },
  projectName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  openBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: colors.accentSoft },
  openText: { color: colors.accent, fontSize: 12.5, fontWeight: '600' },
  openBadge: { color: colors.ok, fontSize: 11.5, fontWeight: '600' },
  pairCard: { backgroundColor: colors.surface, borderRadius: 16, padding: 14, gap: 8, marginTop: 6 },
  pairTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  step: { color: colors.textDim, fontSize: 13.5, lineHeight: 19 },
  code: { color: colors.text, fontFamily: mono, fontSize: 22, fontWeight: '700', letterSpacing: 0.5, textAlign: 'center', paddingVertical: 10 },
  qrWrap: { alignItems: 'center', paddingVertical: 10 },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8 },
  shareText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  safety: { color: colors.textDim, fontFamily: mono, fontSize: 15, textAlign: 'center', paddingBottom: 4 },
  pairFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  wait: { flex: 1, color: colors.textMuted, fontSize: 12.5 },
  cancel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
});
