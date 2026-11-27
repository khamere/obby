// Canonical list of slash commands the client itself handles before
// (or instead of) sending them on the wire.  Kept centralized so the
// slash command completion (src/components/chat/completionProviders.tsx) and
// the dispatcher (src/hooks/useMessageSending.ts) can't drift apart.
//
// Each entry mirrors the fields a draft/bot-cmds schema would publish,
// so the popover + param-hint can render them with the same code path
// as PushBot commands.
//
// To add a new client-only command:
//   1. add an entry below
//   2. add the matching `lowerName === "..."` branch to handleCommand
//      in src/hooks/useMessageSending.ts
//   3. that's it — the popover and param hint pick it up automatically
//
// The commands in APP_COMMAND_NAMES open or change something in the app
// itself. runAppCommand in src/hooks/useMessageSending.ts handles those, and
// answers in the chat where the command was typed.

import { t } from "@lingui/core/macro";
import type { BotCommandOption } from "../types";

export function formatOptions(options: BotCommandOption[] | undefined): string {
  if (!options || options.length === 0) return "";
  return options
    .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
    .join(" ");
}

export interface ClientCommand {
  name: string;
  description: string;
  options?: BotCommandOption[];
  /** Where the command makes sense.  Channel-only commands won't
   *  show in DM views. */
  scope?: "anywhere" | "channel-only";
}

// Function rather than module-scope const: `t` evaluates eagerly, and
// at import time the i18n catalogue hasn't been activated yet, so a
// module-level `t\`...\`` would freeze in the source-locale string.
// Callers re-invoke this on every render anyway (it's the popover/dispatcher
// reading the live list), so the per-call allocation is fine.
export function getClientCommands(inChannel = true): ClientCommand[] {
  return [
    {
      name: "rainbow",
      description: t`Send a message in rainbow colors`,
      options: [{ name: "message", type: "string", required: true }],
    },
    {
      name: "me",
      description: t`Send an action / emote`,
      options: [
        {
          name: "action",
          type: "string",
          required: true,
          description: t`What you're doing`,
        },
      ],
    },
    {
      name: "msg",
      description: t`Open a private message to a user`,
      options: [
        { name: "user", type: "user", required: true },
        {
          name: "message",
          type: "string",
          required: true,
          description: t`First message to send`,
        },
      ],
    },
    {
      name: "whisper",
      description: t`Whisper to a user in the current channel context`,
      scope: "channel-only",
      options: [
        { name: "user", type: "user", required: true },
        { name: "message", type: "string", required: true },
      ],
    },
    {
      name: "join",
      description: t`Join a channel`,
      options: [
        {
          name: "channel",
          type: "channel",
          required: true,
          description: t`Channel to join (#name)`,
        },
      ],
    },
    {
      name: "part",
      description: t`Leave a channel`,
      options: [
        {
          name: "channel",
          type: "channel",
          required: false,
          description: t`Channel to leave (defaults to current)`,
        },
      ],
    },
    {
      name: "nick",
      description: t`Change your nickname on this server`,
      options: [
        {
          name: "newnick",
          type: "string",
          required: true,
          description: t`New nickname`,
        },
      ],
    },
    {
      name: "slap",
      description: t`Slap someone around a bit with a large trout`,
      options: [
        { name: "user", type: "user", required: true },
        {
          name: "item",
          type: "string",
          required: false,
          description: t`What to slap them with (defaults to a large trout)`,
        },
      ],
    },
    {
      name: "topic",
      description: t`Show or change a channel's topic`,
      options: [
        {
          name: "channel",
          type: "channel",
          required: false,
          description: t`Channel (defaults to current)`,
        },
        {
          name: "topic",
          type: "string",
          required: false,
          description: t`New topic`,
        },
      ],
    },
    {
      name: "away",
      description: t`Mark yourself as away`,
      options: [
        {
          name: "reason",
          type: "string",
          required: false,
          description: t`Away message`,
        },
      ],
    },
    {
      name: "back",
      description: t`Mark yourself as back`,
    },
    {
      name: "query",
      description: t`Open private chat`,
      options: [{ name: "user", type: "user", required: true }],
    },
    {
      name: "whois",
      description: t`View profile`,
      options: [{ name: "user", type: "user", required: false }],
    },
    {
      name: "ignore",
      description: t`Ignore user`,
      options: [{ name: "user", type: "user", required: false }],
    },
    {
      name: "unignore",
      description: t`Unignore user`,
      options: [{ name: "user", type: "user", required: false }],
    },
    {
      name: "list",
      description: t`Find channels`,
    },
    // "clear" sits before "close" so a half-typed name completes to the one
    // that takes nothing away from the server.
    {
      name: "clear",
      description: t`Clear this view and keep saved history`,
    },
    {
      name: "close",
      description: inChannel ? t`Leave channel` : t`Close conversation`,
    },
    {
      name: "raw",
      description: t`Send a raw line to the IRC server`,
      options: [{ name: "line", type: "string", required: true }],
    },
  ];
}

export const APP_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "query",
  "whois",
  "ignore",
  "unignore",
  "list",
  "clear",
  "close",
  "raw",
]);

// Name set is locale-independent so it can stay module-scope.
export const CLIENT_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "rainbow",
  "me",
  "msg",
  "whisper",
  "slap",
  "join",
  "part",
  "nick",
  "topic",
  "away",
  "back",
  ...APP_COMMAND_NAMES,
]);

export interface TypedAppCommand {
  name: string;
  /** Everything after the name, as typed. */
  argumentText: string;
}

// The name ends at the first whitespace, so "/list@bot" and "//list" stay
// what they are: a bot's command and a literal slash.
export function typedAppCommand(text: string): TypedAppCommand | null {
  const match = /^\/([^\s/@]+)(\s[\s\S]*)?$/.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!APP_COMMAND_NAMES.has(name)) return null;
  return { name, argumentText: match[2] ?? "" };
}

export const isAppCommand = (text: string): boolean =>
  typedAppCommand(text) !== null;

export function clientCommandUsage(name: string): string {
  const signature = formatOptions(
    getClientCommands().find((c) => c.name === name)?.options,
  );
  return signature ? `/${name} ${signature}` : `/${name}`;
}

// A nick, as opposed to a list of them or a nick!user@host mask. The ignore
// list matches nicks with wildcards, so its commands take those too.
export function isNickWord(word: string, allowWildcards = false): boolean {
  if (!word || word.startsWith(":") || /[\s,!@]/.test(word)) return false;
  return allowWildcards || !/[*?]/.test(word);
}

// The classic mIRC /slap. The text goes out on the wire as an ACTION, so it
// stays in English for everyone, like the original.
export function slapAction(args: readonly string[]): string | null {
  const [nick, ...item] = args.filter((a) => a.length > 0);
  if (!nick) return null;
  const withWhat = item.length > 0 ? item.join(" ") : "a large trout";
  return `slaps ${nick} around a bit with ${withWhat}`;
}
