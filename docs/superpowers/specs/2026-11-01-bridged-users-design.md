# Bridged users: show shoutbox people as themselves

Date: 2026-11-01. Branch `feat/bridged-users`, based on `community-fixes`
(35c1baa9). Companion data file: `bridges.json` in a separate, linkable
repository.

## Intent

Most private trackers bridge their site shoutbox into IRC through a bot.
In Obby such a line shows as the bot, with the real person's name stuck
inside the text:

```text
Bot      03:47 PM
[mara] But I do agree with that
```

Every tracker wraps the name differently. The person using Obby wants
mara to appear as the sender, with mara's own nick colour and the
bracket gone, the way a native IRC user does, and they want the per-tracker
knowledge to live in a shared file linked from Obby, exactly like Custom
CSS, so adding a tracker is a commit to that file and not an Obby release.

The model is ThatNeoByte's "Shoutbox Beautifier" userscript for The
Lounge, which does this with a hard-coded handler table. This design moves
the table out of the code and into a linkable JSON file, and does the
rewrite once when the message arrives instead of patching the DOM.

## Goals

- A bridged shoutbox line is stored and shown with the real person as the
  sender and the bridge prefix removed from the text.
- Grouping, nick colour, mention detection, reply quoting, copy and
  search all see the real person, because the stored message already does.
- Rules come from a linked JSON file fetched at start (last good copy
  cached), plus an optional pasted-in set that overrides it, mirroring
  `src/lib/customCss.ts` and its settings field.
- A bridged line stays recognisable as bridged: a small "via Bot" marker,
  and the original line on hover.
- Networks where web users join IRC themselves under a wrapped nick, such
  as `(Jeditwo)` on InfinityHD, show the bare name in message rows with a
  "via web" marker, without touching the IRC user behind it.
- Rules can never make Obby fetch anything or hang the UI.
- Ships with a seed `bridges.json` covering the networks whose formats
  were verified against a soju message archive plus the ones ThatNeoByte
  documents.

## Non-goals

- Avatars, ranks or class icons from the tracker sites. That needs
  logged-in requests per site and is a separate project.
- Tab-completion of bridged nicks. A reasonable follow-up, not in scope.
- Reformatting announce or RPG bot output (DarkPeers `[New-Request]-...`,
  SeedPool `[RPG]`, IdleRPG). Those are bot messages, not people.
- Anything outgoing. Replying still goes to the channel as plain text; the
  bridge bot carries it to the site as it does today.
- Re-processing messages already in the store when rules change. New rules
  apply to messages that arrive after they load. Reopening the app or
  scrolling history back in picks them up.

## Anti-goals

- A bridged user that is indistinguishable from an IRC user. Anyone can
  type `[staff] please send me your password` through a nick named Bot,
  so the marker is mandatory and cannot be turned off by the rules file.
- A rules format that accepts arbitrary regular expressions from a remote
  file. Templates only; see below.
- Network requests other than the one fetch of the link the user chose.

## Constraints

- Everything stays in the browser, like Custom CSS: link, cache and own
  rules in `localStorage`. Nothing is sent to soju or the IRC network.
- Obby already has the upstream host of every sidebar row via
  `networkHost(server, network)` in `src/lib/networkHost.ts`; rules are
  keyed on that same string so the CSS file and the bridges file address
  networks the same way.
- Strings go through Lingui like every other setting (18 locales, run the
  extraction step used by the other community-fixes PRs).
- Tests with Vitest under `tests/`, mirroring `src/` like the existing tests.

## The rules file

JSON, served from any host whose raw-file link sends CORS headers (on a
Gitea-style forge that is the API raw path, not the plain raw path).

```json
{
  "version": 1,
  "rules": [
    { "host": "irc.lst.gg", "bot": "Bot", "formats": ["[{nick}] {text}"] },
    { "host": "irc.homiehelpdesk.net", "bot": "BBot", "formats": ["[{nick}] (WEB): {text}"] },
    { "host": "irc.reelflix.cc", "bot": "WALL-E", "formats": ["[Chatbox] {nick}: {text}"] },
    {
      "host": "irc.nebulance.io",
      "bot": "Sauron",
      "channels": ["#ant"],
      "formats": ["[SB] ({nick}): {text}", "[SB] {nick}: {text}"],
      "note": "unverified, from ThatNeoByte"
    },
    { "host": "irc.infinityhd.net", "nickFormat": "({nick})", "label": "web" }
  ]
}
```

Fields:

- `host` (required): the upstream IRC host, lowercase, as `networkHost`
  reports it. Matched case-insensitively.
- `bot`: the nick the bridge speaks as. Compared case-insensitively after
  stripping mode prefixes (`@`, `+`, ...). Required unless `nickFormat` is
  given.
- `channels`: optional list; when present the rule applies only in those
  channels (case-insensitive). Default: every channel on that host.
- `formats`: one or more templates tried in order; the first that matches
  wins. Required with `bot`.
- `nickFormat`: a template applied to the sender nick itself, for networks
  where web users are real IRC users under a wrapped nick. It must consume
  the whole nick and contain exactly one `{nick}`. The message text is
  untouched. Mutually exclusive with `bot`/`formats`.
- `label`: the word shown in the marker for `nickFormat` rules ("via
  web"). Default `web`. Ignored for `bot` rules, whose marker always names
  the bot.
- `note`: free text, ignored by Obby. Used to mark unverified entries.

Templates are literal text with placeholders:

- `{nick}`: one to 32 characters, no whitespace, and not containing the
  character that follows the placeholder in the template.
- `{text}`: the rest of the message, may be empty.
- `{_}`: any run of characters up to the next literal; thrown away. For
  ranks such as `»Name (Rank)« text`.

A single space in a template matches one or more whitespace characters.
Everything else matches literally. Templates are anchored at the start and
must end with `{text}`, except `nickFormat` templates, which are anchored
at both ends and have no `{text}`.
They compile to regular expressions built from bounded character classes
with no nested quantifiers, so matching is linear; the compiler rejects
anything else.

Validation limits (reject the whole file with a clear status message if
exceeded): 1 MB, 500 rules, template length 200, at most one `{nick}` and
one `{text}` per template. Invalid individual rules are skipped and
counted; the settings field shows "N rules loaded, M skipped".

Own rules override linked ones per `(host, bot)` key, or `(host, "nick")`
for `nickFormat` rules; everything else from the link stays.

Matching runs on the message with IRC formatting codes removed
(`stripIrcFormatting` in `src/lib/messageFormatter.ts`), because some
bridges colour the prefix: ReelFlix sends `\x0304[Chatbox]\x03 nick: text`
on every line. The stored `content` is the `{text}` part of that stripped
string; `bridgedOriginal` keeps the raw content, formatting included.

The link is empty until the user pastes one, exactly like Custom CSS.
Nothing is fetched by default.

## Obby changes

### `src/lib/bridgeRules.ts` (new)

A store built like `customCss.ts`: `loadBridgeRules()` called from
`main.tsx` next to `loadCustomCss()`, `setBridgeRulesLink()`,
`saveOwnBridgeRules()`, `useBridgeRulesState()` for the settings field,
`LinkStatus` with the same five values, keys `obby.bridgeRules`,
`obby.bridgeRules.link`, `obby.bridgeRules.linkCache`. The fetch uses the
same options (`no-cache`, `credentials: "omit"`, `no-referrer`) and the
same "looks like an HTML page" rejection.

Also a pure function with no store access, so it is trivially testable:

```ts
applyBridgeRules(rules: CompiledRules, host: string, channel: string,
                 sender: string, text: string):
  { nick: string; text: string } | null
```

The compiled form indexes rules by host, then by bot nick, so the hot
path for a message from a non-bot nick is one map lookup.

A boolean setting `bridgedUsers` (default on) in the same settings
section switches the rewrite off without forgetting the link.

### Message type

Two optional fields on `Message` in `src/types/index.ts`:

- `bridgedVia?: string`: the bot nick the line really came from, or, for
  `nickFormat` rules, the rule's `label`.
- `bridgedOriginal?: string`: the raw content before the prefix was removed.
  Not set for `nickFormat` rules.
- `displayNick?: string`: for `nickFormat` rules only, the unwrapped name.
  `userId` keeps the real IRC nick (`(Jeditwo)`), so every lookup keyed on
  the username (avatar, metadata colour, away status, pronouns, member
  list, nick click, reply target) keeps working.

### CHANMSG handler

In `src/store/handlers/messages.ts`, in the first `ircClient.on("CHANMSG")`
listener: after the msgid duplicate checks and before the ignore check,
resolve the server's upstream host (a small helper that reads
`state.servers` and `state.bouncers` the way `BouncerServerGroup.tsx` does
and calls `networkHost`), call `applyBridgeRules`, and when it returns a
result use its nick and text for everything that follows: the ignore check
runs against both the bot and the extracted nick, mention detection and
`extractMentions` run on the stripped text, and `newMessage` gets
`userId: nick`, `content: text`, `bridgedVia`, `bridgedOriginal`, and
`tags` without the `bot` tag, so the person is not shown with the BOT
badge the bridge carries on some networks.

For a `nickFormat` match, the handler leaves `userId` and `content` as
they are and sets `displayNick` and `bridgedVia` (the label). Mention
detection, ignore list and everything else run on the real nick as today.

When the extracted nick is the current user's own nick (the user posting
in the site shoutbox from a browser), mention detection and notifications
are suppressed as for an own message, but the line is still stored and
rendered as a bridged line from that nick, never as the user's own
message: `isCurrentUser` in `MessageItem` is false whenever `bridgedVia`
is set. Anyone typing `[theirnick] ...` into a shoutbox therefore cannot
produce a line styled as theirs.

The metadata lazy-fetch (`metadataList`) and the labeled-response echo
path keep using the real sender; a bridged line is never our own echo.
The second CHANMSG listener (CTCP) and the bot-tools listener are untouched;
they read `response` directly.

History replay goes through the same listener, so scrolled-in history is
rewritten too. USERMSG (private messages) and the `MULTILINE_MESSAGE`
listener are out of scope: bridges do not speak in PMs, and none of the
verified bridges uses `draft/multiline` (zero such batches in the archive);
a bridge that splits a long post sends separate PRIVMSGs, and only the
first carries the prefix. The rest stay as bot lines.

### Rendering

In `src/components/message/MessageItem.tsx`, when `message.bridgedVia` is
set:

- the header shows `displayNick` when set, otherwise `userId`, and the
  reply quote and copy-as-text use the same name;
- after the timestamp in the header, a muted `via Bot` (the bot nick, or
  the label, neither translated) in the same style as other header
  metadata;
- the nick element carries `title` with the original line
  (`bridgedOriginal`) or, for `nickFormat` rules, the real IRC nick;
- the nick colour is computed from the displayed name, so `Jeditwo` on
  InfinityHD gets the colour `Jeditwo` has everywhere else;
- a `data-bridged` attribute on the row so Custom CSS can style it.

Grouping in `ChatArea.tsx` compares `userId` and must also compare
`bridgedVia`, so a bridged `mara` and an IRC user `mara` never share a
header and every run of bridged lines starts with the marker. For
`nickFormat` lines `userId` is already distinct from any bare nick. The
member list is not changed in this work; it keeps showing `(Jeditwo)`,
which is the nick to type to address them.

### Settings field

`src/components/ui/settings/BridgeRulesField.tsx`, a copy of
`CustomCssField.tsx` with: link input with Save/Remove and status line,
a textarea for own rules with Upload `.json`, Save and Remove, a line
"N rules loaded, M skipped" for each source, and the `bridgedUsers`
toggle. Registered in `allSettings.ts` under Preferences, subcategory
"Bridged users", right after Custom CSS, with search keywords `bridge`,
`shoutbox`, `bot`, `chatbox`.

### Docs

`docs/bridged-users.md` next to `docs/custom-css.md`: what it does, the
file format, how to find a network's host, how to add a tracker, the
security note about the marker.

## Seed `bridges.json`

Observed in a soju message archive on 2026-11-01 (sample size in
brackets). These go in as verified:

| host                       | bot          | format                     | samples |
| -------------------------- | ------------ | -------------------------- | ------- |
| irc.aither.cc              | Chatbot      | `[{nick}] {text}`          | 364     |
| irc.darkpeers.org          | DP           | `[{nick}] {text}`          | 8508    |
| irc.digitalcore.club       | ENDOR        | `<{nick}> {text}`          | 1365    |
| irc.homiehelpdesk.net      | BBot         | `[{nick}] (WEB): {text}`   | 246     |
| irc.lst.gg                 | Bot          | `[{nick}] {text}`          | 10818   |
| irc.luminarr.me            | Luminarr     | `[{nick}] {text}`          | 478     |
| irc.midnightscene.cc       | MSBridge     | `[{nick}]: {text}`         | 4795    |
| irc.onlyencodes.cc         | bridgebot    | `[{nick}] {text}`          | 1397    |
| irc.reelflix.cc            | WALL-E       | `[Chatbox] {nick}: {text}` | 62      |
| irc.skipthecommercials.xyz | STC-Shout    | `<{nick}> {text}`          | 122     |
| irc.upload.cx              | ULCX         | `[{nick}]: {text}`         | 2999    |
| irc.yu-scene.net           | YUS          | `[{nick}] {text}`          | 7373    |
| irc.znth.cx                | Zenith       | `[{nick}]: {text}`         | 17387   |
| irc.infinityhd.net         | (nickFormat) | `({nick})`                 | 429     |

From ThatNeoByte's handler table, marked `"note": "unverified"`:

| host                    | bot           | formats                                        |
| ----------------------- | ------------- | ---------------------------------------------- |
| irc.beyond-hd.me        | Willie        | `[SB] {nick}: {text}`, `[SB] ({nick}): {text}` |
| irc.nebulance.io (#ant) | Sauron        | `[SB] ({nick}): {text}`, `[SB] {nick}: {text}` |
| irc.rocket-hd.cc        | Rocketnouncer | `🛰️{nick}: {text}`                             |

Hawke's bridges are left out because their IRC host is not known. Lines
from these bots that match no template (welcome messages, announce
formats, continuation lines of split messages) stay as bot messages.

## Left to the builder

- The exact helper for server → upstream host in the store, and whether to
  memoise it per serverId.
- How the compiled-rules object is shared between the store and the
  handler (module-level getter is fine; it is how `getCustomCssState`
  works).
- Test layout under `tests/lib` and `tests/store`, following the existing store handler tests.
- Exact wording and placement of the marker within the header's existing
  flex row, as long as it is visibly muted and present on every bridged
  line.
- Whether the seed file lives at the repo root or under a folder; the
  README of obby-css gets a section either way. The seed file and README
  section are part of this work and are written locally; publishing them
  is a separate step the repo owner takes.
