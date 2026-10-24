import { Ionicons } from '@expo/vector-icons';
import type { Effort, ModelInfo, SessionMeta } from '@pocket/protocol';
import * as Haptics from '../haptics';
import { Image } from 'expo-image';
import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { alert } from '../alert';
import { attachmentChars, fromClipboard, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, pickPhotos, previewUri, type Attachment } from '../attachments';
import { usePcClipboard } from '../pc-clipboard';
import { contextLabel, effortLabel, modelLabel, parseSlash, resolveEffort, resolveModel, suggestionsFor, type CommandName, type Suggestion } from '../commands';
import { colors, mono } from '../theme';

export interface ComposerActions {
  send(text: string, attachments: Attachment[]): boolean;
  stop(): void;
  configure(patch: { model?: string | null; effort?: Effort | null }): void;
  newChat(): void;
  agents(): void;
  kill(): void;
}

const ATTACHMENTS_ONLY_TEXT = 'See the attached files.';

export function ClaudeComposer({
  running,
  session,
  models,
  actions,
}: {
  running: boolean;
  session: SessionMeta | undefined;
  models: readonly ModelInfo[];
  actions: ComposerActions;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const pc = usePcClipboard();

  const paste = () => {
    if (!pc.target) return setNotice('No computer shares its clipboard yet: install PocketClipboard on the PC');
    if (!pc.target.online) return setNotice(`${pc.target.name} is offline`);
    setAttaching(true);
    setNotice(null);
    pc.read()
      .then((items) => {
        if (!items.length) return setNotice(`The clipboard on ${pc.target?.name ?? 'the PC'} is empty`);
        const got = fromClipboard(items);
        if (got.text) setText((prev) => (prev && !prev.startsWith('/') ? `${prev}\n${got.text}` : got.text));
        setAttachments((prev) => {
          const next = [...prev, ...got.attachments].slice(0, MAX_ATTACHMENTS);
          while (next.length > prev.length && attachmentChars(next) > MAX_ATTACHMENT_CHARS) next.pop();
          if (next.length - prev.length < got.attachments.length) setNotice('Some items were too large to attach');
          return next;
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not read the PC clipboard'))
      .finally(() => setAttaching(false));
  };

  const suggestions = useMemo(() => suggestionsFor(text, models, session), [text, models, session]);
  const slash = text.startsWith('/');
  const canSend = slash ? text.length > 1 : text.trim().length > 0 || attachments.length > 0;

  const tap = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  const openPicker = (prefill: string) => {
    tap();
    setNotice(null);
    setText(prefill);
    input.current?.focus();
  };

  const attach = (source: 'camera' | 'library') => {
    setAttaching(true);
    setNotice(null);
    pickPhotos(source, attachments)
      .then((picked) => picked.length && setAttachments((prev) => [...prev, ...picked]))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not attach the photo'))
      .finally(() => setAttaching(false));
  };

  const askPhotoSource = () => {
    Keyboard.dismiss();
    alert('Add a photo', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Gallery', onPress: () => attach('library') },
      { text: 'Camera', onPress: () => attach('camera') },
    ]);
  };

  // Claude Code runs /compact itself when it arrives as a message; the chat shows a line once it is done.
  const compact = () => {
    Keyboard.dismiss();
    if (running) return setNotice('Wait for the reply to finish, then compact');
    if (actions.send('/compact', [])) tap();
  };

  const confirmCompact = () => {
    const c = session?.context;
    alert(
      'Compact this chat?',
      c ? `${Math.round(c.tokens / 1000)}k of ${Math.round(c.max / 1000)}k tokens in use. Claude keeps a summary of the conversation and frees the rest.` : 'Claude keeps a summary of the conversation and frees the rest.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Compact', onPress: compact },
      ],
    );
  };

  const runCommand = (name: CommandName) => {
    setText('');
    switch (name) {
      case 'model':
        return openPicker('/model ');
      case 'effort':
        return openPicker('/effort ');
      case 'compact':
        return compact();
      case 'agents':
        Keyboard.dismiss();
        return actions.agents();
      case 'paste':
        return paste();
      case 'photo':
        return askPhotoSource();
      case 'new':
        return actions.newChat();
      case 'stop':
        return actions.stop();
      case 'kill':
        return alert('Stop everything?', 'Kills all Claude processes on the Mac and all running commands on the Windows laptop.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Stop everything', style: 'destructive', onPress: actions.kill },
        ]);
    }
  };

  const setModel = (value: string) => {
    actions.configure({ model: value });
    setText('/effort ');
  };

  const setEffort = (value: Effort | null) => {
    actions.configure({ effort: value });
    setText('');
  };

  const pick = (s: Suggestion) => {
    tap();
    setNotice(null);
    if (s.kind === 'command') {
      if (s.command.argHint) setText(`/${s.command.name} `);
      else runCommand(s.command.name);
    } else if (s.kind === 'model') {
      setModel(s.value);
    } else {
      setEffort(s.value);
    }
  };

  const submitSlash = () => {
    const cmd = parseSlash(text)!;
    if (cmd.name === 'model' && cmd.arg) {
      const value = resolveModel(cmd.arg, models);
      if (value) return setModel(value);
      return setNotice(`Unknown model "${cmd.arg}"`);
    }
    if (cmd.name === 'effort' && cmd.arg) {
      const value = resolveEffort(cmd.arg);
      if (value !== undefined) return setEffort(value);
      return setNotice(`Unknown level "${cmd.arg}"`);
    }
    const first = suggestions[0];
    if (first?.kind === 'command' && first.command.name === cmd.name) return pick(first);
    if (suggestions.length === 1) return pick(suggestions[0]!);
    setNotice(`Unknown command /${cmd.name}`);
  };

  const send = () => {
    if (!canSend) return;
    setNotice(null);
    if (slash) return submitSlash();
    if (actions.send(text.trim() || ATTACHMENTS_ONLY_TEXT, attachments)) {
      tap();
      setText('');
      setAttachments([]);
    }
  };

  const stop = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    actions.stop();
  };

  return (
    <View style={styles.root}>
      {suggestions.length > 0 ? (
        <View style={styles.popover}>
          <ScrollView keyboardShouldPersistTaps="always" style={styles.popoverScroll}>
            {suggestions.map((s) => (
              <Pressable key={s.key} onPress={() => pick(s)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.borderHi }]}>
                <View style={styles.optionBody}>
                  <Text style={[styles.optionTitle, s.kind === 'command' && styles.optionCommand]}>
                    {s.title}
                    {s.kind === 'command' && s.command.argHint ? <Text style={styles.optionHint}>{` <${s.command.argHint}>`}</Text> : null}
                  </Text>
                  <Text style={styles.optionDesc} numberOfLines={1}>
                    {s.description}
                  </Text>
                </View>
                {s.kind !== 'command' && s.current ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.chipsScroll} contentContainerStyle={styles.chips}>
        <Chip icon="sparkles-outline" label={modelLabel(session, models)} onPress={() => openPicker('/model ')} />
        <Chip icon="bulb-outline" label={effortLabel(session)} onPress={() => openPicker('/effort ')} />
        {contextLabel(session) ? <Chip icon="layers-outline" label={contextLabel(session)!} onPress={confirmCompact} /> : null}
        <Chip icon="pulse-outline" label="Agents" onPress={actions.agents} />
        {pc.target ? <Chip icon="clipboard-outline" label={pc.target.name} onPress={paste} /> : null}
      </ScrollView>

      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text style={styles.notice}>{notice}</Text>
        </Pressable>
      ) : null}

      {attachments.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs} keyboardShouldPersistTaps="always">
          {attachments.map((a) => (
            <View key={a.key} style={styles.thumb}>
              {previewUri(a) ? (
                <Image source={{ uri: previewUri(a) }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : (
                <View style={styles.fileTile}>
                  <Ionicons name="document-text-outline" size={22} color={colors.textDim} />
                  <Text style={styles.fileName} numberOfLines={2}>
                    {a.name ?? 'file'}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                hitSlop={8}
                style={styles.thumbRemove}
                accessibilityLabel="Remove attachment"
              >
                <Ionicons name="close" size={14} color="#FFFFFF" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.pill}>
        <Pressable onPress={() => attach('camera')} onLongPress={askPhotoSource} style={styles.camera} accessibilityLabel="Take a photo">
          {attaching ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="camera" size={18} color="#FFFFFF" />}
        </Pressable>
        <TextInput
          ref={input}
          style={[styles.input, slash && styles.inputSlash]}
          value={text}
          onChangeText={(t) => {
            setText(t);
            if (notice) setNotice(null);
          }}
          placeholder="Message… or / for commands"
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={20000}
          autoCapitalize={slash ? 'none' : 'sentences'}
          autoCorrect={!slash}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
        />
        {canSend ? (
          <Pressable onPress={send} hitSlop={8} accessibilityLabel="Send" style={styles.sendBtn}>
            <Text style={styles.send}>{slash ? 'Run' : 'Send'}</Text>
          </Pressable>
        ) : running ? (
          <Pressable onPress={stop} hitSlop={8} accessibilityLabel="Stop" style={styles.sendBtn}>
            <Ionicons name="stop-circle" size={28} color={colors.text} />
          </Pressable>
        ) : (
          <View style={styles.icons}>
            <Pressable onPress={() => openPicker('/')} hitSlop={6} accessibilityLabel="Commands">
              <Text style={styles.slashIcon}>/</Text>
            </Pressable>
            {pc.target ? (
              <Pressable onPress={paste} hitSlop={6} accessibilityLabel={`Paste from ${pc.target.name}`} style={!pc.target.online && { opacity: 0.4 }}>
                <Ionicons name="clipboard-outline" size={23} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => attach('library')} hitSlop={6} accessibilityLabel="Choose from gallery">
              <Ionicons name="image-outline" size={24} color={colors.text} />
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

function Chip({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.borderHi }]}>
      <Ionicons name={icon} size={13} color={colors.textDim} />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  popover: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
    overflow: 'hidden',
  },
  popoverScroll: { maxHeight: 280 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  optionBody: { flex: 1, gap: 1 },
  optionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  optionCommand: { fontFamily: mono, fontSize: 14 },
  optionHint: { color: colors.textMuted, fontWeight: '400' },
  optionDesc: { color: colors.textMuted, fontSize: 12.5 },
  chipsScroll: { flexGrow: 0 },
  chips: { flexDirection: 'row', gap: 6, paddingHorizontal: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 160,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
  },
  chipText: { color: colors.textDim, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  notice: { color: colors.danger, fontSize: 12.5, paddingHorizontal: 6 },
  thumbs: { gap: 8, paddingHorizontal: 2 },
  thumb: { width: 64, height: 64, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  fileTile: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, padding: 4 },
  fileName: { color: colors.textDim, fontSize: 9.5, textAlign: 'center' },
  thumbRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 44, borderRadius: 24, backgroundColor: colors.surfaceHi, paddingHorizontal: 6, paddingVertical: 6, gap: 8 },
  camera: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, maxHeight: 120, minHeight: 32, paddingVertical: 5, paddingHorizontal: 0, color: colors.text, fontSize: 15 },
  inputSlash: { fontFamily: mono, fontSize: 14 },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 16, height: 32, paddingRight: 8 },
  slashIcon: { color: colors.text, fontSize: 22, fontWeight: '300', fontFamily: mono, width: 18, textAlign: 'center' },
  sendBtn: { height: 32, justifyContent: 'center', paddingHorizontal: 8 },
  send: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
