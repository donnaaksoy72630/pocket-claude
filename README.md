# Pocket Claude

Claude Code running on a Mac, driven from an Android phone through a chat that lives inside an app styled like a social network. Paired Windows computers lend their workspace (VS Code extension) or just their clipboard (PocketClipboard) to the same chat.

Everything between devices is end-to-end encrypted; the relay only sees ciphertext.

## Parts

| Path | What it is |
|---|---|
| `apps/brain` | Mac daemon: runs Claude Code (Agent SDK), owns sessions, permissions and paired devices. CLI `pocket-claude pair \| relay \| status`. Chats of invited people run in chat-only mode (no files), with `pc_*` tools for their own PocketClipboard computer: clipboard read/write and screenshots. |
| `apps/relay` | Relay: Cloudflare Worker (`worker.ts`) or Node server (`node-server.ts`) on the same core. Routing, offline queues, pairing. The Node server also serves the Mini App. |
| `apps/mobile` | Expo / React Native app (Android, iPhone) and, as a web build, the Telegram Mini App. The chat is in Direct. |
| `apps/executor-extension` | VS Code extension: executes tool calls in the open workspace, has a chat panel. |
| `apps/clipboard-agent` | `PocketClipboard.exe` for Windows: shares the clipboard with the phone and shows the chat with Claude in a small overlay window in the corner, where you can also write to it (double-tap Alt shows it, one Alt tap or Esc hides it; dark or light). |
| `apps/telegram-bot` | Telegram bot run by the brain daemon (`pocket-claude telegram <token>`): a permanent keyboard for the PC clipboard, screenshots and chats with Claude, “Code → PC” / “Reply → PC” under every reply, one linked account per person; opens the Mini App. |
| `packages/protocol` | Crypto, envelopes, message schemas, pairing. |
| `packages/transport` | `DeviceLink` (authenticated, encrypted WebSocket link) and `joinAccount` (pairing). |
| `packages/client-core` | Chat state and formatting shared by the phone, the VS Code panel and the overlay. |

## Development

```sh
pnpm install
pnpm test          # vitest, all packages
pnpm typecheck     # tsc, all packages
pnpm tsx tools/scripts/dev-stack.ts   # local relay + brain + fake executor, prints a pairing link
```

The phone app: see `apps/mobile/README.md`.

## Install

- Mac: `apps/brain/install/install.sh` sets up LaunchAgents for the relay, the brain and a sleep blocker.
- Windows: `tools/scripts/make-usb.sh` builds a folder with `PocketClipboard.exe` and the VS Code extension. A friend's laptop needs only the exe: run it, paste the link from the phone (chat → phone icon → Add a computer), done.
- A friend: the owner opens Settings → Invite a person and shows the QR code; the friend scans it with Pocket, picks a name, then adds their computer and links Telegram from Settings. Their chats answer from the Mac without any access to its files.
- iPhone: `npx expo run:ios --device --configuration Release` in `apps/mobile` on the Mac (Xcode needed); see `apps/mobile/README.md`.

## Voice calls

The phone icon in a chat starts a call: speech is recognised on the phone, a short pause sends the sentence to the same chat, and the reply is read aloud as it streams. The call keeps going with the screen off (iOS background audio). On a call Claude answers in a few spoken sentences and uses the `pc_*` tools for "put this command in my clipboard", "take a screenshot", "read my clipboard". Needs the native modules `expo-speech-recognition`, `expo-speech`, `expo-audio`: rebuild the app after pulling.

## Telegram Mini App

The same app inside Telegram, served by the Node relay on the Mac over its public HTTPS address (Tailscale Funnel):

```sh
pnpm --filter @pocket/mobile export:web      # apps/mobile/dist; the relay picks it up on restart
pocket-claude telegram app                   # or: telegram app https://host/  — the bot's menu button and /app open it
```

`/app` in the bot sends a button with a one-time pairing code, so the app pairs itself as another device of the same person. Credentials stay in the WebView's localStorage; nothing is stored with Telegram. `STATIC_DIR=` (empty) stops the relay from serving the app; `EXPO_PUBLIC_RELAY_URL` at export time points a build hosted elsewhere at the relay.

## Roadmap

See `PLAN.md` (in Russian): wave 2 — compact overlay with themes, chat-only mode and PC tools for invited people, the permanent Telegram keyboard, iOS performance, brand personas, QR onboarding and voice calls — implemented, awaiting hands-on acceptance.
