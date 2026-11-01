# Bridged Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show shoutbox people bridged into IRC by a bot as the sender of their own lines, driven by a linkable JSON rules file, with InfinityHD-style wrapped nicks unwrapped for display.

**Architecture:** A pure template compiler and rule matcher in `src/lib`, a link-plus-own rules store modelled on `customCss.ts`, one rewrite point in the store's `CHANMSG` listener that stores the real person as `userId` and keeps the bot on `bridgedVia`, and a marker in `MessageHeader`. Grouping breaks on `bridgedVia` so the marker heads every bridged run.

**Tech Stack:** React, TypeScript, Zustand, Lingui, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-bridged-users-design.md`

## Global Constraints

- Branch `feat/bridged-users` on top of `community-fixes`. Commits are one-line conventional commits with a scope and no AI attribution (CLAUDE.md).
- Every user-visible string goes through Lingui; all 18 non-English catalogues get a translation before commit (CLAUDE.md i18n section).
- Tests live under `tests/`, mirroring `src/`.
- Rules file limits: 1 MB, 500 rules, template length 200, `{nick}` 1 to 32 characters without whitespace. Templates compile to regular expressions with no nested quantifiers.
- Storage keys: `obby.bridgeRules`, `obby.bridgeRules.link`, `obby.bridgeRules.linkCache`. Fetch options: `cache: "no-cache"`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`. Link empty by default.
- Marker text is the bot nick or the rule label, never translated. The marker cannot be disabled by the rules file.
- Before the final push: the CI gate in CLAUDE.md (`lefthook` check, i18n, docs, `npm run test`) plus `npm run build`.

## Review Focus

1. A bot line whose prefix is wrapped in colour codes (ReelFlix: `\x0304[Chatbox]\x03 nick: text`) must still match and must store a clean nick. Pinned in Task 2.
2. A line from the bot that matches no template (welcome messages, split continuation lines) must stay a plain bot message with no `bridgedVia`. Pinned in Task 4.
3. A real IRC user with the same nick as a bridged person must never share a header with them. Pinned in Task 5.
4. The current user's own nick arriving through the bridge must not notify or count as a mention, and must not render as "mine". Pinned in Tasks 4 and 5.
5. A rules file with one broken rule among good ones must load the good ones and report the skipped count, and a file that is HTML, too large or not JSON must be rejected with the right status. Pinned in Tasks 2 and 3.

---

### Task 1: Template compiler

**Files:**

- Create: `src/lib/bridgeTemplates.ts`
- Test: `tests/lib/bridgeTemplates.test.ts`

**Interfaces:**

- Produces:
  - `export type TemplateKind = "message" | "nick"`
  - `export interface BridgeMatch { nick: string; text: string }` (`text` is `""` for the nick kind)
  - `export function compileTemplate(template: string, kind: TemplateKind): RegExp | null` (null when invalid)
  - `export function matchTemplate(re: RegExp, input: string): BridgeMatch | null`

Template grammar (from the spec): literal text; `{nick}` → `([^\s<next>]{1,32})` where `<next>` is the literal character after the placeholder, if any; `{text}` → `([\s\S]*)`, allowed only once and only at the very end of a `message` template; `{_}` → `[^<next>]*` (no capture); one literal space → `\s+`; everything else regex-escaped. Anchored with `^` (and `$` for the nick kind). Invalid: length over 200, no `{nick}`, more than one `{nick}`, unknown `{...}` placeholder, a `message` template not ending in `{text}`, a `nick` template containing `{text}`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { compileTemplate, matchTemplate } from "../../src/lib/bridgeTemplates";

const m = (tpl: string, input: string) => {
  const re = compileTemplate(tpl, "message");
  return re && matchTemplate(re, input);
};

describe("compileTemplate", () => {
  it("matches the verified formats", () => {
    expect(m("[{nick}] {text}", "[mara] But I do agree")).toEqual({
      nick: "mara",
      text: "But I do agree",
    });
    expect(m("[{nick}]: {text}", "[chevron]: i use TrueNAS")).toEqual({
      nick: "chevron",
      text: "i use TrueNAS",
    });
    expect(m("<{nick}> {text}", "<Skuff> moin.. :)")).toEqual({ nick: "Skuff", text: "moin.. :)" });
    expect(m("[{nick}] (WEB): {text}", "[homie] (WEB): lol")).toEqual({
      nick: "homie",
      text: "lol",
    });
    expect(m("[Chatbox] {nick}: {text}", "[Chatbox] 4SURE: hi there")).toEqual({
      nick: "4SURE",
      text: "hi there",
    });
    expect(m("🛰️{nick}: {text}", "🛰️neo: yo")).toEqual({ nick: "neo", text: "yo" });
  });
  it("lets one space match a run of whitespace and allows empty text", () => {
    expect(m("[{nick}] {text}", "[a]   b")).toEqual({ nick: "a", text: "b" });
    expect(m("[{nick}] {text}", "[a] ")).toEqual({ nick: "a", text: "" });
  });
  it("does not match other prefixes or an empty nick", () => {
    expect(m("[{nick}] {text}", "[New-Request]-[Name: x]")).toBeNull();
    expect(m("[{nick}] {text}", "[] hi")).toBeNull();
    expect(m("[{nick}] {text}", "plain text")).toBeNull();
  });
  it("throws away {_} and keeps the nick", () => {
    expect(m("»{nick} ({_})« {text}", "»Name (Rank)« hi")).toEqual({ nick: "Name", text: "hi" });
  });
  it("compiles nick templates anchored at both ends", () => {
    const re = compileTemplate("({nick})", "nick");
    expect(re && matchTemplate(re, "(Jeditwo)")).toEqual({ nick: "Jeditwo", text: "" });
    expect(re && matchTemplate(re, "(Jeditwo)x")).toBeNull();
    expect(re && matchTemplate(re, "Jeditwo")).toBeNull();
  });
  it("rejects invalid templates", () => {
    expect(compileTemplate("[{nick}]", "message")).toBeNull();
    expect(compileTemplate("{text}", "message")).toBeNull();
    expect(compileTemplate("[{nick}] {nick} {text}", "message")).toBeNull();
    expect(compileTemplate("[{bogus}] {text}", "message")).toBeNull();
    expect(compileTemplate("({nick}) {text}", "nick")).toBeNull();
    expect(compileTemplate(`${"x".repeat(200)}{nick} {text}`, "message")).toBeNull();
  });
  it("rejects a nick longer than 32 characters", () => {
    expect(m("[{nick}] {text}", `[${"n".repeat(33)}] hi`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/bridgeTemplates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `compileTemplate` and `matchTemplate` in `src/lib/bridgeTemplates.ts`**

Tokenise the template with `/\{(nick|text|_)\}|[^{]+|\{/g`; a bare `{` is a literal. Build the pattern piece by piece, looking one character ahead for `<next>`. `matchTemplate` returns group 1 as `nick` and the last group (if any) as `text`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/bridgeTemplates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridgeTemplates.ts tests/lib/bridgeTemplates.test.ts
git commit -m "feat(bridges): compile bridge message templates to safe patterns"
```

---

### Task 2: Rules parsing, merging and matching

**Files:**

- Create: `src/lib/bridgeRules.ts` (pure part; the store is added in Task 3)
- Test: `tests/lib/bridgeRules.test.ts`

**Interfaces:**

- Consumes: `compileTemplate`, `matchTemplate` from Task 1; `stripIrcFormatting(text: string): string` from `src/lib/messageFormatter.ts`.
- Produces:
  - `export const MAX_RULES_CHARS = 1_000_000`, `export const MAX_RULES = 500`
  - `export interface BridgeRule { host: string; bot?: string; channels?: string[]; formats?: string[]; nickFormat?: string; label?: string; note?: string }`
  - `export interface ParsedBridgeRules { rules: BridgeRule[]; skipped: number }`
  - `export function parseBridgeRules(json: string): ParsedBridgeRules` — throws `Error("too-large")`, `Error("bad-json")`, `Error("bad-version")` (version must be `1`), `Error("too-many-rules")`. A rule is skipped (counted) when `host` is not a non-empty string, when neither `bot`+`formats` nor `nickFormat` is present, when both are present, when any template fails to compile, or when `channels` is present but not a string array.
  - `export function mergeBridgeRules(linked: BridgeRule[], own: BridgeRule[]): BridgeRule[]` — own replaces linked per key `host.toLowerCase() + "\0" + (bot?.toLowerCase() ?? "nick")`; order: linked rules not overridden, then own.
  - `export type CompiledRules` (opaque) and `export function compileBridgeRules(rules: BridgeRule[]): CompiledRules`
  - `export const EMPTY_RULES: CompiledRules`
  - `export type BridgeResult = { kind: "bot"; nick: string; text: string; via: string } | { kind: "nick"; displayNick: string; via: string }`
  - `export function applyBridgeRules(rules: CompiledRules, host: string, channel: string, sender: string, text: string): BridgeResult | null`

Matching: `sender` is compared after stripping leading mode prefixes (`/^[~&@%+!]+/`), case-insensitively; `host` and `channel` case-insensitively; the message is matched against `stripIrcFormatting(text)`; `via` is the bot nick as written in the rule (bot kind) or `label ?? "web"` (nick kind). Nick rules are tried only when no bot rule matched the sender.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  applyBridgeRules,
  compileBridgeRules,
  mergeBridgeRules,
  parseBridgeRules,
} from "../../src/lib/bridgeRules";

const file = (rules: unknown[]) => JSON.stringify({ version: 1, rules });
const compiled = (rules: unknown[]) => compileBridgeRules(parseBridgeRules(file(rules)).rules);
const LST = { host: "irc.lst.gg", bot: "Bot", formats: ["[{nick}] {text}"] };
const RFX = { host: "irc.reelflix.cc", bot: "WALL-E", formats: ["[Chatbox] {nick}: {text}"] };
const IHD = { host: "irc.infinityhd.net", nickFormat: "({nick})", label: "web" };

describe("parseBridgeRules", () => {
  it("parses good rules and counts skipped ones", () => {
    const out = parseBridgeRules(
      file([
        LST,
        { host: "x" },
        { host: "y", bot: "b", formats: ["{text}"] },
        { ...LST, nickFormat: "({nick})" },
      ]),
    );
    expect(out.rules).toEqual([LST]);
    expect(out.skipped).toBe(3);
  });
  it("rejects the whole file when it is not usable", () => {
    expect(() => parseBridgeRules("<!doctype html>")).toThrow("bad-json");
    expect(() => parseBridgeRules(JSON.stringify({ version: 2, rules: [] }))).toThrow(
      "bad-version",
    );
    expect(() => parseBridgeRules(file(Array.from({ length: 501 }, () => LST)))).toThrow(
      "too-many-rules",
    );
    expect(() => parseBridgeRules("x".repeat(1_000_001))).toThrow("too-large");
  });
});

describe("mergeBridgeRules", () => {
  it("lets an own rule replace the linked one for the same host and bot", () => {
    const own = { ...LST, formats: ["<{nick}> {text}"] };
    expect(mergeBridgeRules([LST, RFX], [own])).toEqual([RFX, own]);
  });
});

describe("applyBridgeRules", () => {
  const rules = compiled([
    LST,
    RFX,
    IHD,
    {
      host: "irc.nebulance.io",
      bot: "Sauron",
      channels: ["#ant"],
      formats: ["[SB] {nick}: {text}"],
    },
  ]);
  it("rewrites a bot line on the right network", () => {
    expect(applyBridgeRules(rules, "irc.lst.gg", "#general", "Bot", "[mara] hi")).toEqual({
      kind: "bot",
      nick: "mara",
      text: "hi",
      via: "Bot",
    });
  });
  it("ignores case and mode prefixes on the sender and host", () => {
    expect(applyBridgeRules(rules, "IRC.LST.GG", "#general", "@bot", "[mara] hi")?.kind).toBe(
      "bot",
    );
  });
  it("matches through IRC colour codes", () => {
    expect(
      applyBridgeRules(
        rules,
        "irc.reelflix.cc",
        "#general",
        "WALL-E",
        "\x0304[Chatbox]\x03 4SURE: hi",
      ),
    ).toEqual({ kind: "bot", nick: "4SURE", text: "hi", via: "WALL-E" });
  });
  it("returns null for the same bot on another network, another nick, a non-matching line, or the wrong channel", () => {
    expect(applyBridgeRules(rules, "irc.znth.cx", "#general", "Bot", "[mara] hi")).toBeNull();
    expect(applyBridgeRules(rules, "irc.lst.gg", "#general", "alice", "[mara] hi")).toBeNull();
    expect(applyBridgeRules(rules, "irc.lst.gg", "#general", "Bot", "Welcome aboard")).toBeNull();
    expect(
      applyBridgeRules(rules, "irc.nebulance.io", "#other", "Sauron", "[SB] x: hi"),
    ).toBeNull();
    expect(applyBridgeRules(rules, "irc.nebulance.io", "#ANT", "Sauron", "[SB] x: hi")?.kind).toBe(
      "bot",
    );
  });
  it("unwraps a wrapped nick without touching the text", () => {
    expect(
      applyBridgeRules(rules, "irc.infinityhd.net", "#infinityhd", "(Jeditwo)", "o/ all"),
    ).toEqual({ kind: "nick", displayNick: "Jeditwo", via: "web" });
    expect(
      applyBridgeRules(rules, "irc.infinityhd.net", "#infinityhd", "Jeditwo", "o/ all"),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/bridgeRules.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the pure part of `src/lib/bridgeRules.ts`**

`CompiledRules` is `{ byHost: Map<string, { bots: Map<string, { via: string; channels?: Set<string>; formats: RegExp[] }[]>; nicks: { re: RegExp; via: string; channels?: Set<string> }[] }> }`. Keep the file header comment in the style of `customCss.ts`: what the two sources are, what is sanitised, and that the only request is the link.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/bridgeRules.test.ts tests/lib/bridgeTemplates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridgeRules.ts tests/lib/bridgeRules.test.ts
git commit -m "feat(bridges): parse, merge and apply bridge rules"
```

---

### Task 3: Rules store (link, own, cache) and the setting key

**Files:**

- Modify: `src/lib/bridgeRules.ts` (append the store)
- Modify: `src/main.tsx:49` (call `loadBridgeRules()` after `loadCustomCss()`)
- Modify: `src/store/types.ts` (`GlobalSettings`: add `bridgedUsers: boolean` next to `stripImageMetadata`)
- Modify: `src/store/index.ts:1383` region (defaults: `bridgedUsers: true`)
- Test: `tests/lib/bridgeRules.test.ts` (extend)

**Interfaces:**

- Consumes: `isValidCssLink(link: string): boolean` from `src/lib/customCss.ts` (reuse; it only checks the scheme). `LinkStatus` type from `customCss.ts`.
- Produces:
  - `export interface BridgeRulesState { own: string; ownRules: ParsedBridgeRules; link: string; linkJson: string; linkRules: ParsedBridgeRules; linkStatus: LinkStatus }`
  - `export function loadBridgeRules(): void`
  - `export function saveOwnBridgeRules(input: string): void` — throws the parse errors from Task 2; `""` removes.
  - `export async function setBridgeRulesLink(input: string): Promise<void>` — throws `Error("bad-link")`.
  - `export function getBridgeRulesState(): BridgeRulesState`, `export function useBridgeRulesState(): BridgeRulesState`
  - `export function getCompiledBridgeRules(): CompiledRules` — the merged, compiled set, recomputed on every state update.
  - `export function resetBridgeRulesForTests(): void`

Mirror `customCss.ts` exactly for storage, `refreshSeq`, status transitions (`cached` while a cached copy exists and the fetch is in flight or failed, `error` otherwise) and the HTML-page rejection (`/^\s*<(!doctype|html)/i` → `Error("not-json")`, status `error`).

- [ ] **Step 1: Write the failing tests**

Model the setup on `tests/lib/customCss.test.ts` lines 128 to 160 (mocked `localStorage`, `vi.stubGlobal("fetch", fetchMock)`).

```ts
describe("bridge rules store", () => {
  it("starts empty and fetches nothing", () => {
    loadBridgeRules();
    expect(getBridgeRulesState().linkStatus).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fetches a link with no credentials, applies it, caches it, and own rules win", async () => {
    await setBridgeRulesLink("https://example.test/bridges.json");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    });
    expect(getBridgeRulesState().linkStatus).toBe("ok");
    expect(
      applyBridgeRules(getCompiledBridgeRules(), "irc.lst.gg", "#g", "Bot", "[a] b")?.kind,
    ).toBe("bot");
    saveOwnBridgeRules(file([{ ...LST, formats: ["<{nick}> {text}"] }]));
    expect(
      applyBridgeRules(getCompiledBridgeRules(), "irc.lst.gg", "#g", "Bot", "[a] b"),
    ).toBeNull();
    expect(storage.get("obby.bridgeRules.linkCache")).toBeTruthy();
  });
  it("keeps the cached copy when the host is down and reports an HTML page as an error", async () => {
    // first fetch ok, then reject → status "cached"; then a fresh link that returns "<!doctype html>" → "error"
  });
  it("removing the link clears the cache and the rules", async () => {
    /* setBridgeRulesLink("") */
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/bridgeRules.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement the store, the `main.tsx` call and the setting key**

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/lib/bridgeRules.test.ts && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridgeRules.ts src/main.tsx src/store/types.ts src/store/index.ts tests/lib/bridgeRules.test.ts
git commit -m "feat(bridges): load bridge rules from a link and from the browser"
```

---

### Task 4: Rewrite bridged lines when they arrive

**Files:**

- Modify: `src/types/index.ts:387` (`Message`: add `bridgedVia?: string; bridgedOriginal?: string; displayNick?: string` with one-line comments from the spec)
- Modify: `src/lib/networkHost.ts` (add `upstreamHostForServer`)
- Modify: `src/store/handlers/messages.ts:122-330` (first `CHANMSG` listener)
- Test: `tests/store/bridgedUsers.test.ts`, `tests/lib/customCss.test.ts` (it already imports `networkHost`; add one case for the new helper there or in a new `tests/lib/networkHost.test.ts`)

**Interfaces:**

- Consumes: `getCompiledBridgeRules`, `applyBridgeRules`, `resetBridgeRulesForTests`, `saveOwnBridgeRules` (Task 3); `networkHost(server, network)`.
- Produces: `export function upstreamHostForServer(state: Pick<AppState, "servers" | "bouncers">, serverId: string): string` in `src/lib/networkHost.ts` — finds the server, resolves `state.bouncers[server.bouncerServerId]?.networks[server.bouncerNetid]` as `BouncerServerGroup.tsx:181-186` does, returns `networkHost(server, network)` or `""`.

Handler change, after the msgid duplicate checks and before the ignore check:

```ts
const bridged = globalSettings.bridgedUsers
  ? applyBridgeRules(
      getCompiledBridgeRules(),
      upstreamHostForServer(store.getState(), response.serverId),
      channelName,
      response.sender,
      message,
    )
  : null;
const shownSender = bridged?.kind === "bot" ? bridged.nick : response.sender;
const shownText = bridged?.kind === "bot" ? bridged.text : message;
```

Then: the ignore check runs for `response.sender` and, when different, `shownSender`; `isOwnMessage` stays computed from `response.sender` for the echo path, but a new `isOwnBridged = bridged?.kind === "bot" && shownSender.toLowerCase() === currentServerUser?.username?.toLowerCase()` suppresses `hasMention`, `mentions` and `notifyChatMessage` the way `isOwnMessage` does; `checkForMention`/`extractMentions` take `shownText`; `newMessage` gets `content: shownText`, `userId: shownSender`, and when `bridged` is set `bridgedVia: bridged.via`, plus for the bot kind `bridgedOriginal: message` and `tags` with the `bot` key removed, plus for the nick kind `displayNick: bridged.displayNick`. `metadataList` and the bot-flagging block keep `response.sender`.

- [ ] **Step 1: Write the failing tests**

Set up like `tests/store/botTools.test.ts`: `useStore.setState` with one server (`id: SID, host: "irc.lst.gg"`, one channel `#general`, `users: []`) and `globalSettings.bridgedUsers: true`; `saveOwnBridgeRules(file([LST, IHD]))` in `beforeEach`; `resetBridgeRulesForTests()` in `afterEach`; `emit("CHANMSG", { serverId: SID, sender, channelName: "#general", message, timestamp: new Date(), mtags })`; read `useStore.getState().messages[`${SID}-${channelId}`]`.

```ts
test("a matching bot line is stored as the person", () => {
  // sender "Bot", message "[mara] hi" → last message: userId "mara", content "hi", bridgedVia "Bot", bridgedOriginal "[mara] hi"
});
test("a bot line that matches no template stays the bot's", () => {
  // sender "Bot", message "Welcome aboard" → userId "Bot", bridgedVia undefined
});
test("the bot tag does not follow the person", () => {
  // mtags { bot: "" } → stored tags has no "bot" key
});
test("my own nick through the bridge is not a mention", () => {
  // current user "me" (mock ircClient.getCurrentUser), message "[me] me: test" → mentioned [] and userId "me", bridgedVia "Bot"
});
test("a mention inside the stripped text still counts", () => {
  // message "[mara] me: hi" → mentioned ["me"]
});
test("the setting off leaves lines untouched", () => {
  // globalSettings.bridgedUsers false → userId "Bot", content "[mara] hi"
});
test("a wrapped nick gets a display nick and keeps its userId", () => {
  // server host "irc.infinityhd.net", sender "(Jeditwo)", message "o/" → userId "(Jeditwo)", displayNick "Jeditwo", bridgedVia "web", content "o/"
});
test("upstreamHostForServer uses the bouncer network's host", () => {
  // server { bouncerServerId: "b", bouncerNetid: "7", host: "bouncer.example" }, bouncers.b.networks["7"].attributes.host "irc.lst.gg" → "irc.lst.gg"
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/store/bridgedUsers.test.ts`
Expected: FAIL (fields undefined, helper missing).

- [ ] **Step 3: Implement the type fields, the helper and the handler change**

- [ ] **Step 4: Run the store tests and the type check**

Run: `npx vitest run tests/store tests/lib/customCss.test.ts && npx tsc -b`
Expected: PASS, no type errors. Existing `CHANMSG` tests keep passing because with no rules loaded `applyBridgeRules` returns null.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/networkHost.ts src/store/handlers/messages.ts tests/store/bridgedUsers.test.ts
git commit -m "feat(bridges): store bridged shoutbox lines under the person's nick"
```

---

### Task 5: Grouping and rendering

**Files:**

- Modify: `src/lib/messageGrouping.ts:24-40` (`shouldShowMessageHeader`)
- Modify: `src/components/message/MessageHeader.tsx` (props `bridgedVia?: string`, `displayNick?: string`, `originalLine?: string`)
- Modify: `src/components/message/MessageItem.tsx:244` (`isCurrentUser`), `:357-367` (`useNickColor` input, `isBot`), `:425` (`formatCopyAuthor`), `:905-975` (row attribute and header props)
- Modify: `src/components/message/MessageReply.tsx:70` (`replyUsername`)
- Test: `tests/lib/messageGrouping.test.ts`, `tests/components/MessageHeader.test.tsx` (new; follow an existing component test's render setup)

**Interfaces:**

- Consumes: `Message.bridgedVia`, `Message.displayNick`, `Message.bridgedOriginal` (Task 4).
- Produces: `MessageHeader` renders, when `bridgedVia` is set, `<span className="ml-2 text-xs text-{theme}-text-muted" data-bridged-via>via {bridgedVia}</span>` right after the timestamp, and the nick span's `title` is `originalLine`. The nick shown is `displayName || displayNick || userId`.

Rules: `shouldShowMessageHeader` also returns true when `previous.bridgedVia !== message.bridgedVia`. In `MessageItem`: `isCurrentUser` is false when `message.bridgedVia` is set; `useNickColor(message.displayNick ?? message.userId, ...)`; `isBot` is false when `message.bridgedVia` is set; `formatCopyAuthor(displayName, message.displayNick ?? message.userId, isSystem)`; the row gets `data-bridged={message.bridgedVia ? "true" : undefined}`; the header gets `bridgedVia={message.bridgedVia}`, `displayNick={message.displayNick}`, `originalLine={message.bridgedOriginal ?? (message.displayNick ? message.userId : undefined)}`. In `MessageReply`: show `replyMessage.displayNick ?? replyMessage.userId` and colour by the same string; keep `userId` for the click handler.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/messageGrouping.test.ts`:

```ts
it("never groups a bridged person with an IRC user of the same nick, and groups a bridged run", () => {
  expect(shouldShowMessageHeader(msg(), msg({ bridgedVia: "Bot" }))).toBe(true);
  expect(shouldShowMessageHeader(msg({ bridgedVia: "Bot" }), msg())).toBe(true);
  expect(
    shouldShowMessageHeader(
      msg({ bridgedVia: "Bot" }),
      msg({ bridgedVia: "Bot", timestamp: new Date("2026-01-01T12:01:00.000Z") }),
    ),
  ).toBe(false);
});
```

In `tests/components/MessageHeader.test.tsx`:

```ts
it("shows the bridge marker, the display nick and the original line", () => {
  render(<MessageHeader userId="(Jeditwo)" displayNick="Jeditwo" bridgedVia="web" originalLine="(Jeditwo)" timestamp={new Date()} theme="discord" />);
  expect(screen.getByText("Jeditwo")).toBeInTheDocument();
  expect(screen.getByText("via web")).toBeInTheDocument();
  expect(screen.getByText("Jeditwo").closest("span")?.getAttribute("title")).toBe("(Jeditwo)");
});
it("shows no marker for an ordinary line", () => {
  render(<MessageHeader userId="alice" timestamp={new Date()} theme="discord" />);
  expect(screen.queryByText(/^via /)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/messageGrouping.test.ts tests/components/MessageHeader.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the grouping rule, the header props and the `MessageItem` and `MessageReply` changes**

- [ ] **Step 4: Run the tests, the type check and a visual check**

Run: `npx vitest run tests/lib tests/components && npx tsc -b`
Expected: PASS. Then with `npm run dev`, paste own rules for the local test network (CONTRIBUTING.md testing environment) and send `[mara] hello` from a nick named `Bot`: the line shows `mara`, coloured, with a muted `via Bot` after the time, hover shows the original, and a following line from a real `mara` starts a new header.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageGrouping.ts src/components/message/MessageHeader.tsx src/components/message/MessageItem.tsx src/components/message/MessageReply.tsx tests/lib/messageGrouping.test.ts tests/components/MessageHeader.test.tsx
git commit -m "feat(bridges): show bridged people under their own name with a via marker"
```

---

### Task 6: Settings field, setting definitions, docs and translations

**Files:**

- Create: `src/components/ui/settings/BridgeRulesField.tsx`
- Modify: `src/lib/settings/definitions/allSettings.ts:747-760` (insert after the Custom CSS entry)
- Create: `docs/bridged-users.md`
- Modify: `src/locales/*/messages.po` and compiled `.mjs` (via the i18n scripts)

**Interfaces:**

- Consumes: `useBridgeRulesState`, `setBridgeRulesLink`, `saveOwnBridgeRules`, `MAX_RULES_CHARS` (Task 3); `isValidCssLink`; `SettingComponentProps`.
- Produces: two entries in `allSettings.ts`: `{ id: "preferences.bridgedUsers", key: "bridgedUsers", category: "preferences", subcategory: "Bridged users", title: msg`Show bridged users as themselves`, description: msg`Lines a tracker's shoutbox bot relays into IRC are shown as the person who wrote them, marked "via" the bot.`, type: "toggle", defaultValue: true, searchKeywords: ["bridge", "shoutbox", "bot", "chatbox"], priority: 13 }` and `{ id: "preferences.bridgeRules", key: "bridgeRules", category: "preferences", subcategory: "Bridged users", title: msg`Bridge rules`, description: msg`Which bot speaks for which network and how it wraps the name. From a shared link and/or your own JSON. Kept in this browser.`, type: "custom", defaultValue: "", searchKeywords: [...same], priority: 14, customComponent: BridgeRulesField }`.

`BridgeRulesField` is `CustomCssField.tsx` with: a `type="url"` link input (placeholder `https://…/bridges.json`), a textarea whose placeholder reads "Paste rules JSON here or upload a .json file", an upload button accepting `application/json,.json`, a status line reusing the Custom CSS wordings but with "raw .json file", and under each source a line reading "N rules loaded, M skipped" when a source is set. A parse error from `saveOwnBridgeRules` shows "That file is not a valid rules file." (`bad-json`, `bad-version`), "That file is too large.", or "That file has too many rules.". All of these go through Lingui.

`docs/bridged-users.md` follows `docs/custom-css.md`: what it does, the two sources, sharing a file (raw link, CORS, the IP note), the rules format with the field list and the template grammar copied from the spec, "finding a network's host" (same inspect recipe as custom CSS), and a short security paragraph: the marker is always shown because anyone can type a prefix through a bot nick.

- [ ] **Step 1: Write the field, the definitions and the doc**

- [ ] **Step 2: Extract and translate**

Run: `npm run i18n:extract`. Fill every empty `msgstr ""` in the 18 non-English catalogues for the new strings (spawn one agent per locale as CLAUDE.md describes, or translate inline), then `npm run i18n:compile`.

- [ ] **Step 3: Verify**

Run: `npx lefthook run pre-commit --commands check --all-files && npx lefthook run pre-commit --commands i18n --all-files && npx lefthook run pre-commit --commands docs-format,docs-lint --all-files && npx tsc -b`
Expected: all green, no diff left behind. Open Settings → Preferences → Bridged users in `npm run dev`: paste a link, see "N rules loaded, 0 skipped"; paste a broken JSON, see the error line; toggle off and on.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/settings/BridgeRulesField.tsx src/lib/settings/definitions/allSettings.ts docs/bridged-users.md src/locales
git commit -m "feat(settings): bridged users rules from a link or your own file"
```

---

### Task 7: Seed `bridges.json` in obby-css

**Files (repo `/home/bleak/Documents/f around/obby-css`):**

- Create: `bridges.json`
- Modify: `README.md` (new section after `network-logos.css`)
- Modify: `CONTRIBUTING.md` (short "Adding a bridge rule" section)

**Interfaces:**

- Consumes: the file format from Task 2.

`bridges.json` holds `version: 1` and the rules from the spec's two seed tables, verified first in host order, then the three unverified ones each with `"note": "unverified, from ThatNeoByte's Shoutbox Beautifier"`, Anthelion with `"channels": ["#ant"]`, and InfinityHD as `{ "host": "irc.infinityhd.net", "nickFormat": "({nick})", "label": "web" }`.

README section: the raw API link of the file, where to paste it (Settings → Preferences → Bridged users → Load from a link), the list of networks covered, and a line that unverified entries are marked in the file. CONTRIBUTING: how to read a bot's format from a few lines, the template placeholders, and to send a sample line with a change.

- [ ] **Step 1: Write the three files**

- [ ] **Step 2: Verify the file parses with the real parser**

Run from the obby repo: `node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("../obby-css/bridges.json","utf8"));console.log(j.version,j.rules.length)'` and a one-off Vitest spec (not committed) that feeds the file to `parseBridgeRules` and asserts `skipped === 0` and 17 rules.
Expected: `1 17`, `skipped 0`.

- [ ] **Step 3: Commit in obby-css (do not push)**

```bash
git add bridges.json README.md CONTRIBUTING.md
git commit -m "Add bridges.json: shoutbox bridge rules for Obby (17 networks)"
```

---

### Task 8: Whole-branch verification

- [ ] **Step 1: Run the full CI gate and the build**

Run, from the obby repo:

```bash
npx lefthook run pre-commit --commands check --all-files
npx lefthook run pre-commit --commands i18n --all-files
npx lefthook run pre-commit --commands docs-format,docs-lint --all-files
npm run test
npm run build
git status --short
```

Expected: every command exits 0 and `git status` is clean.

- [ ] **Step 2: Live check against the local test stack**

Per CONTRIBUTING.md's testing environment: connect, paste the obby-css `bridges.json` as own rules with one extra rule for the local server's host, send `[mara] hello` and `\x0304[Chatbox]\x03 neo: hi` from nicks `Bot` and `WALL-E`, reload the page, scroll history back in. Expected: both render under the person with the marker, survive the reload (rewritten again from history), and a real user `mara` posting next gets a separate header.

- [ ] **Step 3: Commit anything the gate changed, then stop**

The branch is ready for review. Pushing and opening the PR are the repo owner's call.
