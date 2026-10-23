import { Ionicons } from '@expo/vector-icons';
import type { ActivitySession, BackgroundTask, RunningTool, Subagent } from '@pocket/protocol';
import * as Haptics from '../../src/haptics';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { alert } from '../../src/alert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ClaudeAvatar } from '../../src/components/ClaudeAvatar';
import { effortLabel, modelLabel } from '../../src/commands';
import { bareToolName, STATE_COLOR, STATE_LABEL, toolIcon, toolSummary } from '../../src/format';
import { useScreenActive } from '../../src/hooks';
import { usePowerSaving } from '../../src/power';
import { useChatSelector, useSession } from '../../src/session';
import { colors, mono } from '../../src/theme';

// The Mac reports running agents; every 3 s is live enough and halves the traffic.
const POLL_MS = 3000;
/** Hot phone or Low Power Mode: fresh enough this often, and the timers tick every 5 s. */
const POLL_SAVING_MS = 10_000;

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function Device({ icon, name, online, detail }: { icon: keyof typeof Ionicons.glyphMap; name: string; online: boolean; detail?: string }) {
  return (
    <View style={styles.device}>
      <View style={styles.deviceIcon}>
        <Ionicons name={icon} size={20} color={colors.text} />
        <View style={[styles.deviceDot, { backgroundColor: online ? colors.ok : colors.textMuted }]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.deviceName}>{name}</Text>
        <Text style={styles.deviceDetail} numberOfLines={1}>
          {online ? detail || 'Online' : 'Offline'}
        </Text>
      </View>
    </View>
  );
}

function ToolRow({ tool, now }: { tool: RunningTool; now: number }) {
  return (
    <View style={styles.tool}>
      <Ionicons name={toolIcon(tool.name)} size={14} color={colors.accent} />
      <Text style={styles.toolName}>{bareToolName(tool.name)}</Text>
      <Text style={styles.toolSummary} numberOfLines={1}>
        {toolSummary(tool.name, tool.input)}
      </Text>
      <Text style={styles.toolTime}>{elapsed(tool.startedAt, now)}</Text>
    </View>
  );
}

function SubagentRow({ agent, tools, now }: { agent: Subagent; tools: RunningTool[]; now: number }) {
  const detail = [agent.lastTool && `last: ${agent.lastTool}`, agent.toolUses ? `${agent.toolUses} tool calls` : undefined].filter(Boolean).join(' · ');
  return (
    <View style={styles.sub}>
      <View style={styles.subHead}>
        <Ionicons name="git-branch-outline" size={14} color={colors.accent} />
        <Text style={styles.subTitle} numberOfLines={1}>
          {agent.description}
        </Text>
        <Text style={styles.toolTime}>{elapsed(agent.startedAt, now)}</Text>
      </View>
      <Text style={styles.subMeta} numberOfLines={1}>
        {[agent.type ?? 'subagent', detail].filter(Boolean).join(' · ')}
      </Text>
      {tools.map((t) => (
        <ToolRow key={t.id} tool={t} now={now} />
      ))}
    </View>
  );
}

function BackgroundRow({ task, now }: { task: BackgroundTask; now: number }) {
  return (
    <View style={styles.tool}>
      <Ionicons name="infinite-outline" size={14} color={colors.ok} />
      <Text style={styles.toolName}>{task.id}</Text>
      <Text style={styles.toolSummary} numberOfLines={1}>
        {task.command}
      </Text>
      <Text style={styles.toolTime}>{elapsed(task.startedAt, now)}</Text>
    </View>
  );
}

function AgentCard({ s, now, onOpen }: { s: ActivitySession; now: number; onOpen: () => void }) {
  const computers = useChatSelector((s) => s.computers);
  const computer = computers.find((c) => c.deviceId === s.executorId);
  const agents = s.agents ?? [];
  const background = s.background ?? [];
  const agentToolUses = new Set(agents.map((a) => a.toolUseId).filter(Boolean));
  const ownTools = s.runningTools.filter((t) => !t.parentId && !agentToolUses.has(t.id));
  const orphanTools = s.runningTools.filter((t) => t.parentId && !agents.some((a) => a.toolUseId === t.parentId));
  const models = useChatSelector((s) => s.models);
  const meta = [modelLabel(s, models), effortLabel(s), computer?.name].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.surfaceHi }]}>
      <View style={styles.cardHead}>
        <ClaudeAvatar size={36} active={s.live} />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {s.title || 'New chat'}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <View style={styles.cardRight}>
          <View style={[styles.badge, { borderColor: STATE_COLOR[s.state] }]}>
            <Text style={[styles.badgeText, { color: STATE_COLOR[s.state] }]}>{STATE_LABEL[s.state]}</Text>
          </View>
          {s.turnStartedAt ? <Text style={styles.cardTime}>{elapsed(s.turnStartedAt, now)}</Text> : null}
        </View>
      </View>
      {s.pendingPermissions > 0 ? (
        <View style={styles.pending}>
          <Ionicons name="hand-left-outline" size={13} color={colors.warn} />
          <Text style={styles.pendingText}>
            {s.pendingPermissions === 1 ? 'Waiting for 1 approval' : `Waiting for ${s.pendingPermissions} approvals`}
          </Text>
        </View>
      ) : null}
      {ownTools.length + orphanTools.length > 0 ? (
        <View style={styles.tools}>
          {[...ownTools, ...orphanTools].map((t) => (
            <ToolRow key={t.id} tool={t} now={now} />
          ))}
        </View>
      ) : null}
      {agents.length > 0 ? (
        <View style={styles.tools}>
          {agents.map((a) => (
            <SubagentRow key={a.id} agent={a} tools={s.runningTools.filter((t) => t.parentId && t.parentId === a.toolUseId)} now={now} />
          ))}
        </View>
      ) : null}
      {background.length > 0 ? (
        <View style={styles.tools}>
          <Text style={styles.groupLabel}>Background</Text>
          {background.map((b) => (
            <BackgroundRow key={b.id} task={b} now={now} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client } = useSession();
  // Field by field: the screen stays open while chats stream, and must not re-render for every word.
  const activity = useChatSelector((s) => s.activity);
  const modelsCount = useChatSelector((s) => s.models.length);
  const connection = useChatSelector((s) => s.connection);
  const brainOnline = useChatSelector((s) => s.brainOnline);
  const host = useChatSelector((s) => s.host);
  const computers = useChatSelector((s) => s.computers);
  const activeComputer = useChatSelector((s) => s.activeComputer);
  const active = useScreenActive();
  const powerSaving = usePowerSaving();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active || !client) return;
    client.loadActivity();
    if (modelsCount === 0) client.loadModels();
    const poll = setInterval(() => client.loadActivity(), powerSaving ? POLL_SAVING_MS : POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), powerSaving ? 5000 : 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [active, client, modelsCount, powerSaving]);

  const sessions = activity?.sessions ?? [];
  const subagents = sessions.reduce((n, s) => n + (s.agents?.length ?? 0), 0);
  const tasks = sessions.reduce((n, s) => n + s.runningTools.filter((t) => t.name !== 'Agent').length + (s.background?.length ?? 0), 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const macOnline = connection === 'online' && brainOnline;
  const winOnline = macOnline && (activity?.executor.online ?? host?.executorOnline ?? false);
  const workspaces = activity?.executor.workspaces ?? host?.workspaces ?? [];

  const stopEverything = () =>
    alert('Stop everything?', 'Kills all Claude processes on the Mac and all running commands on the Windows laptop.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop everything',
        style: 'destructive',
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          client?.kill();
        },
      },
    ]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top, height: 52 + insets.top }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Close">
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activity</Text>
          <Text style={styles.subtitle}>
            {sessions.length === 0 ? 'Nothing running' : [plural(sessions.length, 'chat'), plural(subagents, 'subagent'), plural(tasks, 'task')].join(' · ')}
          </Text>
        </View>
        {activity && macOnline ? <View style={styles.liveDot} /> : null}
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.devices}>
          <Device icon="laptop-outline" name="Mac" online={macOnline} detail={activity?.claudeVersion ? `Claude Code ${activity.claudeVersion}` : undefined} />
          {computers.length === 0 ? <Device icon="desktop-outline" name="Windows" online={winOnline} detail={activity?.executor.os} /> : null}
        </View>
        {computers.length > 0 ? (
          <View style={styles.devices}>
            {computers.map((c) => (
              <Device
                key={c.deviceId}
                icon="desktop-outline"
                name={c.deviceId === activeComputer ? `${c.name} ★` : c.name}
                online={macOnline && c.online}
                detail={c.workspaces[0]?.split(/[\\/]/).pop()}
              />
            ))}
          </View>
        ) : null}
        {computers.length === 0 && winOnline && workspaces.length > 0 ? (
          <View style={styles.workspaces}>
            {workspaces.map((w) => (
              <Text key={w} style={styles.workspace} numberOfLines={1} ellipsizeMode="head">
                {w}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.section}>Agents</Text>
        {!macOnline ? (
          <Text style={styles.empty}>The Mac is offline.</Text>
        ) : !activity ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : sessions.length === 0 ? (
          <Text style={styles.empty}>No agents are working right now.</Text>
        ) : (
          sessions.map((s) => (
            <AgentCard key={s.sessionId} s={s} now={now} onOpen={() => router.replace({ pathname: '/direct/[id]', params: { id: s.sessionId } })} />
          ))
        )}

        <Pressable onPress={stopEverything} style={({ pressed }) => [styles.kill, pressed && { opacity: 0.8 }]}>
          <Ionicons name="stop-circle-outline" size={18} color={colors.danger} />
          <Text style={styles.killText}>Stop everything</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ok, marginRight: 4 },
  content: { paddingHorizontal: 14, paddingTop: 8, gap: 10 },
  devices: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  device: { flex: 1, minWidth: 150, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: colors.surface },
  deviceIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceHi, alignItems: 'center', justifyContent: 'center' },
  deviceDot: { position: 'absolute', right: 0, bottom: 0, width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: colors.surface },
  deviceName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  deviceDetail: { color: colors.textMuted, fontSize: 11.5 },
  workspaces: { gap: 2, paddingHorizontal: 4 },
  workspace: { color: colors.textMuted, fontFamily: mono, fontSize: 11.5 },
  section: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 10 },
  empty: { color: colors.textMuted, fontSize: 14, paddingVertical: 12 },
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 12, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  cardMeta: { color: colors.textMuted, fontSize: 12 },
  cardRight: { alignItems: 'flex-end', gap: 3 },
  cardTime: { color: colors.textMuted, fontSize: 11, fontFamily: mono },
  badge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pendingText: { color: colors.warn, fontSize: 12.5, fontWeight: '600' },
  tools: { gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderHi, paddingTop: 10 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolName: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  toolSummary: { flex: 1, color: colors.textMuted, fontFamily: mono, fontSize: 11.5 },
  toolTime: { color: colors.textMuted, fontFamily: mono, fontSize: 11 },
  sub: { gap: 4, paddingLeft: 2 },
  subHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  subMeta: { color: colors.textMuted, fontSize: 11.5, paddingLeft: 20 },
  groupLabel: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  kill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 44,
    marginTop: 16,
    borderRadius: 12,
    backgroundColor: colors.dangerSoft,
  },
  killText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
