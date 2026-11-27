# Persist unsent drafts

## Why

A half-written message lived only in the memory of the chat view. A reload, a phone evicting the app or the
in-app updater restarting it lost the text. Drafts are now kept per chat in local storage, restored on start,
and a sidebar row shows a small pencil when its chat holds unsent text.

## 1. What existed before

- `src/components/layout/ChatArea.tsx` kept a map of drafts in a ref, keyed by server id and chat id, written
  when a chat was left and read when one was opened. The live text is `messageTextRef`; it has two writers,
  `applyText()` and `handleInputChange()`. Only `handleInputChange` sends typing notifications.
- `src/hooks/useCommandInvocation.ts` stashes the draft while a bot command is filled in; meanwhile
  `messageTextRef` holds an argument value, which can be a password. `leave()` clears the stash and leaves the
  argument in `messageTextRef` until the opened chat's text is shown.
- Two effects that call `applyText` or `command.begin` are declared before the effect that shows the opened
  chat's draft, and the upload path calls `applyText(caption)` from a promise after the user may have changed
  chat. With persistence that would write one chat's text under another chat on disk.
- A chat id is made from the name as first seen; a private chat and a renamed channel keep their id while the
  name changes. `src/lib/mutes.ts` keys by lower-cased name for that reason.
- Saved-server ids are stable across restarts. Bouncer networks are saved entries too, so a per-server key
  separates two logins and two networks.
- What may sit on disk is already decided for saved history and is reused: `isEncryptionEngaged()`,
  `isServicesNick()`, the credential-line test for private lines, and the `keepHistory` setting.
  `obbyPeerTrust.shouldAutoResume()` says a peer's lock comes back by itself.
- Encryption sessions and pins are keyed by nick and do not follow a NICK change; the renamed chat is a plain
  chat to the app.
- `snapshotStorage()` in `src/lib/backup.ts` copied every local storage key.

## 2. Behaviour

1. Text in a chat's message box is remembered per chat. It is written to local storage 500 ms after the last
   change, at once when it becomes blank (sent or cleared), and when the page is hidden or unloaded.
2. On start the saved drafts are loaded. Opening a chat shows its draft, also when the chat's row only appears
   after the server connects. A restored draft sends no typing notification.
3. Sending or emptying the box removes the chat's draft from memory and storage in the same step.
4. A sidebar row shows a small pencil when its chat holds non-blank unsent text in this session (stored or
   not, muted or not) and the text is not on screen: always in the narrow layout, and in the wide layout on
   every row but the selected one. A channel row that shows the key mark or the "not in this channel" mark
   shows no pencil, since that chat has no message box until it is joined.
5. The draft is the text only. A reply in progress and attachments are not part of it.
6. Whitespace-only text is no draft: nothing kept, no pencil.

## 3. Rules

Identity: saved-server entry id plus the chat name in lower case. No channel or private kind is stored, since a
server has one namespace for targets.

Never written to storage (the text stays in memory for the session, and a stored copy of that chat is removed):

- text whose first non-space character is `/` (every command);
- text longer than 10,000 characters;
- anything while "Keep chat history on this device" is off;
- in a private chat: a services nick; any line the credential test matches (`identify ...`, `login ...` to a
  bot of any name); a chat whose encryption is engaged; a peer with an Obby pin whose auto-resume is on;
- argument text of a bot command being filled in (the stashed text is the draft).

Only text edited while its chat may be stored is ever written. Text typed under a lock, or while history is
off, is not written later when the lock ends or the setting returns, until it is edited again. Each edit is
marked with whether its chat was allowed at that moment, so this also holds when the lock ends inside the
500 ms before the write. When encryption engages or the setting is turned off, stored drafts that are no longer
allowed are removed at once.

Lifecycle:

- server removed (also a bouncer with its networks, and a network the bouncer deleted): its drafts leave memory
  and storage;
- channel left by the user or a refused new join, private chat closed: draft dropped;
- kicked or parted elsewhere (the row stays): draft kept, back in the box after a rejoin;
- peer changes nick, or channel RENAME: the draft moves to the new name and replaces a draft already there. In
  storage the entry is renamed only if it was stored under the old name and the new name may store it, so text
  that never reached disk does not reach it through a rename;
- disconnect, reconnect, server disabled: untouched;
- "Clear history" in settings does not touch drafts.

Bounds: 10,000 characters per draft; 50 stored drafts (the oldest edit leaves storage first); a stored draft
not edited for 30 days is dropped at start; drafts of servers no longer saved are dropped at start.

Two tabs: each tab loads its copy at start. A write re-reads storage and changes only the chats this tab edited
since its last write; for one chat the last write wins. There is no live sync.

Backup: the drafts key is left out of the file. A restore clears the device's drafts with everything else.

Nothing about drafts is sent to a server or shown outside the message box and the pencil.

## 4. Storage

Local storage key `drafts`: `{ [serverId]: { [lower-cased chat name]: { text: string, at: number } } }`, with
`at` the epoch milliseconds of the last edit. The key is removed when empty. There is no setting, no migration
and nothing on the native side.

## 5. Code

- `src/store/localStorage.ts`: `KEYS.DRAFTS` and `drafts.load()` / `drafts.save()`. `load()` reads anything
  that is not the expected shape as no drafts. `save()` returns false when the browser refused the write and
  leaves storage as it was.
- `src/lib/drafts.ts`: the drafts in memory, the marks for chats edited since the last write, the gate that
  says what may be stored, and one timer. Chat names come from the network, so they are held in maps and the
  stored object is built from entries. Pure helpers for tests: `isStorableDraftText`, `pruneDrafts`,
  `mergeDrafts`. `startDrafts(gate)` loads what is still wanted and allowed. `setDraft` is a no-op for text
  equal to what is held, which keeps opening a chat from refreshing its age or overwriting another tab's newer
  text. `flushDrafts()` merges the marked chats into what storage holds now and tries a failed write again at
  the next flush. `moveDraft`, `forgetServerDrafts` and `useHasDraft` cover renames, removed servers and the
  rows. Nothing is written before `startDrafts` has run.
- `src/store/handlers/drafts.ts`: `mayStoreDraft(store)` is the gate (section 3). The handler starts the
  drafts, flushes when an encryption session or the history setting changes, and flushes when the page is
  hidden or unloaded.
- `src/lib/history/historyLines.ts`: `isCredentialLine()` wraps the test the history recorder already used.
- `src/hooks/useCommandInvocation.ts`: `draftText()` returns the stashed text while a command is filled in,
  else the typed text.
- `src/components/layout/ChatArea.tsx`: every write to the message text records the draft under the open
  chat, but only once the box holds that chat's text. The owner check keeps text of the chat just left, or a
  command argument, from being recorded under the chat just opened. The effects that start a command requested
  from elsewhere run after the effect that shows the opened chat's text: starting a command stashes the box
  text as the chat's draft, so started earlier it would stash the text of the chat just left. An upload that
  never starts hands its caption back to the chat it was written in.
- `src/components/layout/ChannelRow.tsx`, `PrivateChatRow.tsx`: the pencil.
- `src/store/index.ts`, `src/store/handlers/users.ts`, `src/store/renamedChannel.ts`: the lifecycle calls.
- `src/lib/backup.ts`: the snapshot skips the drafts key.

## 6. Cases walked through

- Direct server: keyed by saved id; survives reload, reconnect, disable and enable.
- Bouncer: the control entry and each network are keyed separately; the bouncer's service nick is a services
  nick; a deleted network drops its drafts, so a network added again under the same id starts empty.
- Reload, app eviction, updater restart: the last change is on disk after 500 ms or on hide or unload.
- The selected private chat is reopened at start and gets its draft. Another private chat whose row does not
  come back shows its draft when it is opened again, else the draft expires after 30 days. The selection is
  saved under the nick the chat had when it was selected, so after a peer's nick change a reload reopens the
  chat under the old nick while the draft waits under the new one.
- Second session or another device: drafts are local; nothing tells this device a message was sent elsewhere.
- Two tabs: a draft sent from one tab still shows in the other until that one reloads. A tab that has not seen
  the history setting change keeps its own setting until reload, as saved history does.
- Encrypted chats: pencil for the session, nothing on disk, gone after a restart. A plain draft stored before
  the lock is removed when the lock engages. OTR has no sticky lock, so an OTR chat is plain here whenever no
  session is engaged, as it is for saved history.
- Peer of an encrypted chat changes nick: the draft follows in memory only.
- Storage blocked or full: drafts work in memory; a failed write is tried again at the next flush; no message
  is shown.
- First use, corrupt or foreign data under the key: read as empty, replaced by the next write.
- Limit of any design: text stored as a plain draft and then turned into a command or credential line was on
  disk until the next write removed it.

## Choices

- No command draft survives a restart. A list of password commands would miss cases such as a channel key in
  `/join`, and a miss leaves a password on disk. A half-typed `/me ...` is lost on restart.
- No setting of its own: drafts follow "Keep chat history on this device".
- Encrypted means a private chat with a session in any engaged state, plus any peer with an Obby pin whose
  auto-resume is on.
- Private chats with services nicks are never stored, and neither is a private draft with a line that starts
  like a credential command. Both are the rules saved history uses.
- The pencil is hidden on the open chat in the wide layout, where it would flash with every message typed.
- Closing a private chat, leaving a channel or removing a server discards the draft. Being kicked keeps it.
- Drafts stay out of the settings backup.
- On a rename the moving chat's draft wins over one already under the new name.

## Left out

- A settings toggle, draft state in the Zustand store, keying by chat id, writing only when a chat is left,
  storing drafts inside the saved-server entry, IndexedDB.
- Truncating an over-long draft, encrypting drafts at rest, storing the reply target or attachments.
- Live sync between tabs, reopening private chats at start because they hold a draft.
- Draft preview text in rows, marks on folders or server icons, a "clear draft" menu entry, a storage-full
  message, native-side storage.
