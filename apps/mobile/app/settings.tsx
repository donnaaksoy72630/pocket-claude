import { Ionicons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import * as Haptics from '../src/haptics';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from 'react-native';
import { alert } from '../src/alert';
import { setCallPrefs, useCallPrefs } from '../src/call-prefs';
import { QrCode } from '../src/components/QrCode';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { IconName } from '../src/format';
import { useLock } from '../src/lock';
import { useChatState, useSession } from '../src/session';
import { keyboardLanguages, listVoices, nativeCalls, preferredLanguages } from '../src/speech-engine';
import { openTelegramLink, shareViaTelegram } from '../src/telegram';
import { colors, mono } from '../src/theme';
import { recentUserTexts, resolveCallLanguage } from '../src/voice';

/** Where iOS keeps the voices to download: Read & Speak since iOS 26, Spoken Content before. */
function voicesPath(language: string): string {
  const where = 'iPhone Settings → Accessibility → Read & Speak (Spoken Content before iOS 26) → Voices';
  return language.startsWith('ru') ? `${where} → Russian → Milena (Enhanced)` : `${where}: an Enhanced or Premium voice`;
}

const CALL_LANGUAGES = [
  { value: 'auto', label: 'Auto' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'en-US', label: 'English' },
];

function Section({ title }: { title: string }) {
  return <Text style={styles.section}>{title}</Text>;
}

function Row({
  icon,
  label,
  value,
  hint,
  tint = colors.text,
  onPress,
  right,
}: {
  icon: IconName;
  label: string;
  value?: string;
  hint?: string;
  tint?: string;
  onPress?: () => void;
  right?: ReactNode;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
      <Ionicons name={icon} size={26} color={tint} />
      <View style={styles.rowBody}>
        <Text style={[styles.label, { color: tint }]}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {value !== undefined ? (
        <Text selectable style={styles.value} numberOfLines={1} ellipsizeMode="middle">
          {value}
        </Text>
      ) : null}
      {right}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { credentials, client, unpair } = useSession();
  const state = useChatState();
  const lock = useLock();
  const user = state.host?.user;
  const owner = user?.owner !== false;

  const invite = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    client?.invite();
  };

  // The invitation stays on screen as a QR code the friend scans with their phone; sharing the link is the fallback.
  const invitation = state.invitation;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!invitation) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [invitation]);
  const shareInvite = useCallback(() => {
    if (!invitation) return;
    const text = 'Join my Pocket: open the app, choose "Paste link" and paste this (valid 5 minutes)';
    if (shareViaTelegram(invitation.uri, text)) return;
    const message = `${text}\n${invitation.uri}`;
    void Share.share({ message }).catch(() => alert('Invite link', message));
  }, [invitation]);

  const telegramBot = state.host?.telegramBot;
  const linkTelegram = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    client?.linkTelegram();
  };

  useEffect(() => {
    const link = state.telegramLink;
    if (!link || !client) return;
    client.clearTelegramLink();
    // Opens the bot in Telegram with the code as its start parameter; the bot joins as another device of this person.
    if (openTelegramLink(link.url)) return;
    void Linking.openURL(link.url).catch(() => alert('Telegram', `Open this link within 5 minutes:\n${link.url}`));
  }, [state.telegramLink, client]);

  const stopEverything = () =>
    alert(owner ? 'Stop everything?' : 'Stop your chats?', owner ? 'Kills all Claude processes on the Mac and all running commands on the Windows laptop.' : 'Kills your Claude chats and the commands running on your computers.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: owner ? 'Stop everything' : 'Stop my chats',
        style: 'destructive',
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          client?.kill();
        },
      },
    ]);

  const callPrefs = useCallPrefs();
  const [keyboards, setKeyboards] = useState<string[]>([]);
  useEffect(() => {
    void keyboardLanguages().then(setKeyboards);
  }, []);
  // As the call will pick it: on "auto", Russian chats or a Russian keyboard mean a Russian call.
  const callLanguage = useMemo(
    () => resolveCallLanguage(callPrefs.language, preferredLanguages(), { texts: recentUserTexts(state.threads), keyboards }),
    [callPrefs.language, state.threads, keyboards],
  );
  const [voiceName, setVoiceName] = useState<string | null>(null);
  /** The call language has an Enhanced or Premium voice installed. */
  const [goodVoice, setGoodVoice] = useState(true);
  useEffect(() => {
    let live = true;
    void listVoices(callLanguage)
      .then((voices) => {
        if (!live) return;
        setVoiceName(callPrefs.voice ? (voices.find((v) => v.identifier === callPrefs.voice)?.name ?? null) : null);
        setGoodVoice(voices.some((v) => v.quality !== 'default'));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [callPrefs.voice, callLanguage]);

  const cycleCallLanguage = () => {
    const i = CALL_LANGUAGES.findIndex((l) => l.value === callPrefs.language);
    // A voice belongs to a language: the best one for the new language is picked.
    setCallPrefs({ language: CALL_LANGUAGES[(i + 1) % CALL_LANGUAGES.length]!.value, voice: null });
  };

  const pickVoice = async () => {
    const voices = (await listVoices(callLanguage).catch(() => [])).slice(0, 8);
    const sample = callLanguage.startsWith('ru') ? 'Привет! Так я буду звучать в звонке.' : 'Hi! This is how I will sound on a call.';
    const choose = (voice: string | null) => {
      setCallPrefs({ voice });
      void Speech.stop();
      Speech.speak(sample, { language: callLanguage, ...(voice ? { voice } : {}) });
    };
    const quality = (q: string) => (q === 'premium' ? ' (Premium)' : q === 'enhanced' ? ' (Enhanced)' : '');
    alert(
      'Voice',
      voices.length
        ? `Enhanced and Premium voices sound far more natural. Download one in ${voicesPath(callLanguage)}.`
        : `No voices for this language yet: ${voicesPath(callLanguage)}.`,
      [
        { text: 'Best installed', onPress: () => choose(null) },
        ...voices.map((v) => ({ text: `${v.name}${quality(v.quality)}`, onPress: () => choose(v.identifier) })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const confirmUnpair = () =>
    alert('Unpair this phone?', 'The keys on this phone are erased. You will need to pair again with a new code.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => void unpair() },
    ]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top, height: 48 + insets.top }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Settings and activity</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <Section title="You" />
        <Row icon="person-outline" label={user?.name ?? '—'} hint={user ? (user.owner ? 'Owner of the Mac' : 'Invited by the owner') : 'Waiting for the Mac'} />
        {owner ? (
          <Row
            icon="person-add-outline"
            label="Invite a person"
            hint="They get their own chats and computers on your Mac"
            tint={colors.accent}
            onPress={state.brainOnline ? invite : undefined}
          />
        ) : null}
        {invitation ? (
          <View style={styles.inviteCard}>
            <Text style={styles.inviteTitle}>Let them scan this with Pocket</Text>
            <Text style={styles.inviteHint}>On their phone: open Pocket → Scan. They pick a name and get their own chats.</Text>
            <View style={styles.inviteQr}>
              <QrCode value={invitation.uri} size={200} />
            </View>
            <View style={styles.inviteFoot}>
              <Text style={styles.inviteHint}>
                {invitation.expiresAt > now ? `Valid ${Math.max(0, Math.ceil((invitation.expiresAt - now) / 60000))} min` : 'Expired'}
              </Text>
              <Pressable onPress={shareInvite} hitSlop={8}>
                <Text style={styles.inviteAction}>Send link</Text>
              </Pressable>
              <Pressable onPress={() => client?.clearInvitation()} hitSlop={8}>
                <Text style={styles.inviteAction}>Close</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <Section title="Telegram" />
        <Row
          icon="paper-plane-outline"
          label={telegramBot ? `Link @${telegramBot}` : 'Telegram bot'}
          hint={telegramBot ? 'Get and set the PC clipboard from Telegram' : 'Not set up on the Mac: pocket-claude telegram <token>'}
          tint={telegramBot ? colors.accent : colors.text}
          onPress={telegramBot && state.brainOnline ? linkTelegram : undefined}
        />

        <Section title="Voice calls" />
        <Row
          icon="language-outline"
          label="Language"
          value={callPrefs.language === 'auto' ? `Auto · ${callLanguage}` : (CALL_LANGUAGES.find((l) => l.value === callPrefs.language)?.label ?? callPrefs.language)}
          hint="What you speak on calls; the voice follows it"
          onPress={cycleCallLanguage}
        />
        <Row icon="mic-outline" label="Voice" value={voiceName ?? 'Best installed'} hint="Tap to hear and pick a voice" onPress={() => void pickVoice()} />
        {Platform.OS === 'ios' && !goodVoice ? (
          <Row
            icon="download-outline"
            label="Get a better voice"
            hint={`Only robotic voices for this language so far. ${voicesPath(callLanguage)}. Tap to open iPhone Settings.`}
            tint={colors.accent}
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
        <Row
          icon="volume-high-outline"
          label="Speaker"
          hint="Loudspeaker by default; headphones always win"
          right={<Switch value={callPrefs.speaker} onValueChange={(v) => setCallPrefs({ speaker: v })} trackColor={{ false: colors.borderHi, true: colors.accent }} thumbColor="#FFFFFF" />}
        />
        {nativeCalls ? (
          <>
            <Row
              icon="call-outline"
              label="Show as a phone call"
              hint="Call controls on the lock screen and the green status bar; turn off if calls misbehave"
              right={<Switch value={callPrefs.callKit} onValueChange={(v) => setCallPrefs({ callKit: v })} trackColor={{ false: colors.borderHi, true: colors.accent }} thumbColor="#FFFFFF" />}
            />
            <Row
              icon="hand-left-outline"
              label="Talk over the answer"
              hint="Speaking while it answers stops it"
              right={<Switch value={callPrefs.bargeIn} onValueChange={(v) => setCallPrefs({ bargeIn: v })} trackColor={{ false: colors.borderHi, true: colors.accent }} thumbColor="#FFFFFF" />}
            />
          </>
        ) : null}

        <Section title="Connection" />
        <Row icon="cloud-outline" label="Relay" value={credentials?.relayUrl ?? '—'} />
        <Row icon="person-circle-outline" label="Account" value={credentials?.accountId ?? '—'} />
        <Row icon="phone-portrait-outline" label="This device" value={credentials?.deviceId ?? '—'} />

        <Section title="Security" />
        <Row
          icon="finger-print"
          label="Biometric lock"
          hint={lock.available ? 'Ask on launch and after 60 s in background' : 'No biometrics or screen lock set up on this phone'}
          right={
            <Switch
              value={lock.enabled}
              onValueChange={(v) => void lock.setEnabled(v)}
              trackColor={{ false: colors.borderHi, true: colors.accent }}
              thumbColor="#FFFFFF"
            />
          }
        />

        <Section title="Login" />
        <Row icon="stop-circle-outline" label="Stop everything" tint={colors.danger} onPress={stopEverything} />
        <Row icon="log-out-outline" label="Unpair this phone" tint={colors.accent} onPress={confirmUnpair} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  inviteCard: { marginHorizontal: 16, marginTop: 8, padding: 16, borderRadius: 14, backgroundColor: colors.surface, gap: 8 },
  inviteTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  inviteHint: { color: colors.textMuted, fontSize: 13 },
  inviteQr: { alignItems: 'center', paddingVertical: 8 },
  inviteFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  inviteAction: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 16 },
  back: { width: 28 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  section: { color: colors.textMuted, fontSize: 14, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, minHeight: 56 },
  rowBody: { flexShrink: 1, flexGrow: 1, gap: 2, paddingVertical: 8 },
  label: { fontSize: 16 },
  hint: { color: colors.textMuted, fontSize: 13 },
  value: { flexShrink: 1, maxWidth: '55%', color: colors.textMuted, fontFamily: mono, fontSize: 12.5, textAlign: 'right' },
});
