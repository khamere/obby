/**
 * Hook for handling message sending logic including IRC commands,
 * multiline messages, and protocol formatting
 */
import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { useShallow } from "zustand/react/shallow";
import { base64EncodeUtf8 } from "../lib/base64";
import { botPriority } from "../lib/botPriority";
import {
  clientCommandUsage,
  isNickWord,
  slapAction,
  typedAppCommand,
} from "../lib/clientCommands";
import { coerceOptionValue } from "../lib/commandInvocation";
import {
  CREDENTIAL_COMMAND,
  isServicesNick,
} from "../lib/history/historyLines";
import {
  createIgnorePattern,
  ignoreEntriesFor,
  isUserIgnored,
} from "../lib/ignoreUtils";
import { LINE_BREAK } from "../lib/irc/IRCClient";
import ircClient from "../lib/ircClient";
import { parseJoinCommand, replyTags } from "../lib/ircUtils";
import {
  failWhenUnanswered,
  makeLabel,
  shouldUseLabeledResponse,
  withLabel,
} from "../lib/labeledResponse";
import {
  type FormattingType,
  formatMessageForIrc,
} from "../lib/messageFormatter";
import {
  exceedsLineLimit,
  splitAction,
  splitLongMessage,
} from "../lib/messageProtocol";
import {
  privateChatForOwnMessage,
  showOwnPrivateMessage,
} from "../lib/ownPrivateMessage";
import { PRIVILEGED_COMMANDS } from "../lib/privilegedCommands";
import {
  rainbowText,
  splitRainbowMessage,
  splitRainbowToBytes,
} from "../lib/rainbow";
import useStore, { serverSupportsMultiline } from "../store";
import { routeOutgoingPM } from "../store/handlers/e2eeOutbound";
import { showPresent } from "../store/handlers/history";
import { showCommandReply } from "../store/handlers/serverReplies";
import type { BotCommand, Channel, Message, PrivateChat, User } from "../types";
import { canCarryPassword } from "./useMessageHistory";

/**
 * Try to dispatch a slash command as a +draft/bot-cmd TAGMSG.
 * Returns true if a matching bot command was found and the TAGMSG
 * was sent.  Resolution is scoped to bots the user can actually see
 * as +B in the current view -- never a server-wide name lookup --
 * so a bot lurking in another channel can't shadow `/oper`, `/ns
 * identify`, or any other privileged builtin.
 *
 *   1) explicit `/cmd@botnick` where botnick is a +B user in the
 *      current channel or is the current DM peer (and is +B)
 *   2) otherwise scan +B users in the current channel, ranked by
 *      botPriority
 *   3) DM target if the peer is +B
 * Privileged names listed in PRIVILEGED_COMMANDS are refused
 * outright, and a bare name the server lists in its cmdslist runs
 * on the server.
 */
function tryDispatchBotCommand(
  serverId: string,
  channel: Channel | null,
  privateChat: PrivateChat | null,
  rawCmdName: string,
  args: string[],
): boolean {
  let target = rawCmdName;
  let cmdName = rawCmdName;
  if (rawCmdName.includes("@")) {
    const [c, t] = rawCmdName.split("@", 2);
    cmdName = c;
    target = t;
  } else {
    target = "";
  }
  const lowerCmd = cmdName.toLowerCase();
  if (PRIVILEGED_COMMANDS.has(lowerCmd)) return false;

  const server = useStore.getState().servers.find((s) => s.id === serverId);
  if (!server?.botCommands) return false;
  if (!target && server.cmdsAvailable?.includes(lowerCmd)) return false;
  const bots = server.botCommands;

  const isKnownBotNick = (nick: string): boolean => {
    const k = nick.toLowerCase();
    if (server.bots?.[k]) return true;
    return server.channels.some((c) =>
      c.users.some((u) => u.username.toLowerCase() === k && u.isBot === true),
    );
  };

  type Match = { bot: string; cmd: BotCommand };
  const matches: Match[] = [];
  // explicit target via /cmd@botnick -- must be a +B nick in scope
  if (target) {
    const tkey = target.toLowerCase();
    const inChannel = !!channel?.users.some(
      (u) => u.username.toLowerCase() === tkey && u.isBot === true,
    );
    const isDmPeer =
      !!privateChat &&
      privateChat.username.toLowerCase() === tkey &&
      isKnownBotNick(privateChat.username);
    const list = bots[tkey];
    if (list && (inChannel || isDmPeer)) {
      const cmd = list.find((c) => c.name.toLowerCase() === lowerCmd);
      if (cmd) matches.push({ bot: target, cmd });
    }
  }
  // channel-bot search: must be +B AND in the channel
  if (!matches.length && channel) {
    for (const u of channel.users) {
      if (u.isBot !== true) continue;
      const list = bots[u.username.toLowerCase()];
      if (!list) continue;
      const cmd = list.find((c) => c.name.toLowerCase() === lowerCmd);
      if (cmd) matches.push({ bot: u.username, cmd });
    }
  }
  // DM with a bot -- peer must be +B
  if (!matches.length && privateChat && isKnownBotNick(privateChat.username)) {
    const list = bots[privateChat.username.toLowerCase()];
    if (list) {
      const cmd = list.find((c) => c.name.toLowerCase() === lowerCmd);
      if (cmd) matches.push({ bot: privateChat.username, cmd });
    }
  }
  if (!matches.length) return false;
  const { bot, cmd } = matches.reduce((best, match) =>
    botPriority(server.bots?.[match.bot.toLowerCase()]) <
    botPriority(server.bots?.[best.bot.toLowerCase()])
      ? match
      : best,
  );

  // Naive arg parsing: map positional args onto declared options in
  // order, leftovers concatenated onto the last string-typed option.
  const options: Record<string, string | number | boolean> = {};
  const opts = cmd.options ?? [];
  for (let i = 0; i < opts.length && i < args.length; i++) {
    const o = opts[i];
    const isLast = i === opts.length - 1;
    const raw = isLast ? args.slice(i).join(" ") : args[i];
    const value = coerceOptionValue(o.type, raw);
    if (value !== undefined) options[o.name] = value;
  }

  sendBotCommand(serverId, channel, bot, cmd, options);
  return true;
}

interface AppCommandContext {
  serverId: string;
  chatId: string;
  channel: Channel | null;
  privateChat: PrivateChat | null;
}

// The commands that open or change something in the app. Each one calls the
// store action its menu entry calls, and answers with a row in the chat where
// it was typed, so a refused command never just empties the composer.
function runAppCommand(
  name: string,
  argumentText: string,
  { serverId, chatId, channel, privateChat }: AppCommandContext,
): "withheld" | undefined {
  const store = useStore.getState();
  const chatTarget = channel?.name ?? privateChat?.username;
  const reply = (type: "fail" | "note", code: string, message: string) => {
    // A chat showing older history keeps new rows aside, so we return to the present first.
    if (chatTarget) showPresent(useStore, serverId, chatTarget);
    showCommandReply(
      useStore,
      { serverId, type, command: name.toUpperCase(), code, message },
      chatId,
    );
  };
  const refuse = (code: string, text: string) => {
    reply("fail", code, text);
    return "withheld" as const;
  };
  const note = (code: string, text: string) => {
    reply("note", code, text);
    return undefined;
  };
  const usage = () =>
    refuse("USAGE", t`Not run. Type it as ${clientCommandUsage(name)}`);

  const words = argumentText.split(/\s+/).filter(Boolean);
  const ownNick = ircClient.getNick(serverId);
  const isNick = (word: string, allowWildcards = false) =>
    isNickWord(word, allowWildcards) && !ircClient.isChannel(serverId, word);

  switch (name) {
    case "query": {
      if (words.length !== 1 || !isNick(words[0])) return usage();
      if (words[0].toLowerCase() === ownNick?.toLowerCase())
        return refuse(
          "OWN_NICK",
          t`Not run. ${words[0]} matches your own nick`,
        );
      store.openChat(serverId, words[0]);
      return;
    }
    case "whois": {
      // "/whois server nick" is the classic two-word form, and the nick comes last.
      const typed = words.at(-1);
      if (words.length > 2 || (typed !== undefined && !isNick(typed)))
        return usage();
      const nick = typed ?? privateChat?.username ?? ownNick;
      if (!nick) return usage();
      store.openProfile(serverId, nick);
      return;
    }
    case "ignore":
    case "unignore": {
      if (words.length === 0) {
        store.openPage({
          kind: "settings",
          section: "preferences",
          highlight: "preferences.ignoreList",
          fromSearch: true,
        });
        return;
      }
      if (words.length !== 1 || !isNick(words[0], true)) return usage();
      const ignoreList = store.globalSettings.ignoreList;
      if (name === "unignore") {
        const removed = ignoreEntriesFor(words[0], ignoreList);
        if (removed.length === 0)
          return refuse(
            "NO_MATCH",
            t`Nothing on the ignore list matches ${words[0]}. Type /ignore to see the list`,
          );
        for (const entry of removed) store.removeFromIgnoreList(entry);
        return note("UNIGNORED", t`No longer ignoring ${removed.join(", ")}`);
      }
      const pattern = createIgnorePattern(words[0]);
      // Our own echoed lines would vanish with an entry that covers our nick.
      if (ownNick && isUserIgnored(ownNick, undefined, undefined, [pattern]))
        return refuse(
          "OWN_NICK",
          t`Not run. ${words[0]} matches your own nick`,
        );
      const stored = ignoreList.find(
        (entry) => entry.toLowerCase() === pattern.toLowerCase(),
      );
      if (!stored) store.addToIgnoreList(pattern);
      return note("IGNORED", t`Ignoring ${stored ?? pattern}`);
    }
    case "close": {
      if (words.length > 0) return usage();
      if (channel) {
        store.leaveChannel(serverId, channel.name);
        return;
      }
      if (!privateChat) return usage();
      if (privateChat.isPinned)
        return refuse("PINNED", t`Not closed. Unpin this conversation first`);
      store.deletePrivateChat(serverId, privateChat.id);
      // On a phone the chat column has nothing left to show, so we go back to the list.
      if (useStore.getState().ui.isNarrowView)
        store.setMobileViewActiveColumn("serverList");
      return;
    }
    case "clear": {
      if (words.length > 0) return usage();
      store.clearChatView(serverId, chatId);
      return;
    }
    case "list": {
      if (words.length > 0) return usage();
      store.openPage({ kind: "channelBrowser", serverId });
      return;
    }
    case "raw": {
      // We check for a line break before trimming, so a second line is refused and never sent as a command of its own.
      if (/[\r\n\0]/.test(argumentText))
        return refuse("ONE_LINE", t`Not sent. Put the command on one line`);
      const line = argumentText.trimStart();
      if (!line) return usage();
      if (!ircClient.isSocketOpen(serverId))
        return refuse("NOT_CONNECTED", t`Not connected`);
      ircClient.sendRaw(serverId, line);
      // A raw line can carry a password, so the row never repeats it.
      return note("SENT", t`Sent. The raw log shows the reply`);
    }
  }
}

// Where a command may be invoked. Prefer the spec `contexts`; fall back to the
// legacy obby.world/bot-info `visibility`/`scopes` pair so a private command is
// NEVER routed publicly just because the directory hasn't sent `contexts` yet.
function resolveContexts(cmd: BotCommand): ("public" | "private" | "pm")[] {
  if (Array.isArray(cmd.contexts) && cmd.contexts.length > 0)
    return cmd.contexts;
  const scopes = cmd.scopes ?? ["channel"];
  const priv = cmd.visibility === "private";
  const out: ("public" | "private" | "pm")[] = [];
  if (scopes.includes("channel")) out.push(priv ? "private" : "public");
  if (scopes.includes("dm")) out.push("pm");
  return out.length > 0 ? out : [priv ? "private" : "public"];
}

export function sendBotCommand(
  serverId: string,
  channel: Channel | null,
  bot: string,
  cmd: BotCommand,
  options: Record<string, string | number | boolean>,
): boolean {
  if (!ircClient.isSocketOpen(serverId)) return false;
  const contexts = resolveContexts(cmd);
  const canPublic = contexts.includes("public");
  const canPrivate = contexts.includes("private");
  const canPm = contexts.includes("pm");

  // Per spec §Invoking a command: the base64 of the compact JSON invocation
  // rides in +draft/bot-cmd. How it is addressed depends on the context, and
  // one invocation is exactly one TAGMSG: a command that lists several
  // contexts is sent the one way that fits where the user is, never once per
  // context (a bot that offers "public" and "pm" would otherwise run a channel
  // invocation twice, once in the channel and once in private).
  if (channel && canPublic) {
    // public: TAGMSG to the channel. Name the target bot so that when several
    // bots in the channel share a command name, only the intended one acts.
    const payload = { name: cmd.name, options, bot };
    const b64 = base64EncodeUtf8(JSON.stringify(payload));
    ircClient.sendRaw(
      serverId,
      `@+draft/bot-cmd=${b64} TAGMSG ${channel.name}`,
    );
    return true;
  }
  if (channel && canPrivate) {
    // private: TAGMSG to the bot. The channel travels in the payload, since
    // +draft/channel-context is not valid on TAGMSG.
    const payload = { name: cmd.name, options, channel: channel.name };
    const b64 = base64EncodeUtf8(JSON.stringify(payload));
    ircClient.sendRaw(serverId, `@+draft/bot-cmd=${b64} TAGMSG ${bot}`);
    return true;
  }
  if (canPm) {
    // pm: TAGMSG to the bot, no channel.
    const payload = { name: cmd.name, options };
    const b64 = base64EncodeUtf8(JSON.stringify(payload));
    ircClient.sendRaw(serverId, `@+draft/bot-cmd=${b64} TAGMSG ${bot}`);
    return true;
  }
  return false;
}

interface UseMessageSendingOptions {
  selectedServerId: string | null;
  selectedChannelId: string | null;
  selectedPrivateChatId: string | null;
  selectedChannel: Channel | null;
  selectedPrivateChat: PrivateChat | null;
  currentUser: User | null;
  selectedColor: string | null;
  selectedFormatting: FormattingType[];
  localReplyTo: Message | null;
}

interface UseMessageSendingReturn {
  // Returns "withheld" when an engaged E2EE lock dropped the message or a
  // command was refused, so the caller can preserve the user's draft;
  // otherwise void.
  sendMessage: (text: string) => "withheld" | undefined;
}

interface WhisperContext {
  isWhisper: boolean;
  targetUser: string;
  channelContext: string;
}

function getWhisperContext(
  replyTo: Message | null,
  currentUser: User | null,
): WhisperContext | null {
  if (!replyTo) {
    return null;
  }

  const channelContext =
    replyTo.tags?.["+channel-context"] ||
    replyTo.tags?.["channel-context"] ||
    replyTo.tags?.["+draft/channel-context"] ||
    replyTo.tags?.["draft/channel-context"];

  if (!channelContext) {
    return null;
  }

  const senderUserId = replyTo.userId;
  const currentUserId = currentUser?.username || currentUser?.id;

  const targetUser =
    senderUserId === currentUserId
      ? replyTo.whisperTarget || senderUserId
      : senderUserId;

  return {
    isWhisper: true,
    targetUser,
    channelContext: channelContext as string,
  };
}

type MessageSendCallback = (formattedLine: string) => void;

function sendViaWhisperOrRegular(
  serverId: string,
  whisperContext: WhisperContext | null,
  formattedText: string,
  sendViaNormalChannel: MessageSendCallback,
): void {
  if (whisperContext) {
    ircClient.sendWhisper(
      serverId,
      whisperContext.targetUser,
      whisperContext.channelContext,
      formattedText,
    );
  } else {
    sendViaNormalChannel(formattedText);
  }
}

/**
 * Hook for handling message sending logic including IRC commands,
 * multiline messages, and protocol formatting
 */
export function useMessageSending({
  selectedServerId,
  selectedChannelId,
  selectedPrivateChatId,
  selectedChannel,
  selectedPrivateChat,
  currentUser,
  selectedColor,
  selectedFormatting,
  localReplyTo,
}: UseMessageSendingOptions): UseMessageSendingReturn {
  const { globalSettings, setAway, clearAway } = useStore(
    useShallow((state) => ({
      globalSettings: state.globalSettings,
      setAway: state.setAway,
      clearAway: state.clearAway,
    })),
  );

  /**
   * Handle IRC commands like /join, /part, /nick, etc.
   */
  const handleCommand = useCallback(
    (cleanedText: string) => {
      if (!selectedServerId) return;
      const typed = typedAppCommand(cleanedText);
      const chatId = selectedChannelId ?? selectedPrivateChatId;
      if (typed && chatId)
        return runAppCommand(typed.name, typed.argumentText, {
          serverId: selectedServerId,
          chatId,
          channel: selectedChannel,
          privateChat: selectedPrivateChat,
        });

      const command = cleanedText.substring(1).trim();
      const [commandName, ...args] = command.split(" ");
      // IRC commands are case-insensitive, so /JOIN and /Me get the same
      // client handling as /join and /me. Unknown commands reach the server
      // as typed.
      const lowerName = commandName.toLowerCase();

      if (lowerName === "nick") {
        if (args[0]) useStore.getState().changeNick(selectedServerId, args[0]);
      } else if (lowerName === "join") {
        // We read the arguments from the typed text, where only plain spaces are padding.
        const targets = parseJoinCommand(
          cleanedText.slice(
            cleanedText.indexOf(commandName) + commandName.length,
          ),
        );
        if (targets.length > 0) {
          for (const { name, key } of targets)
            useStore.getState().joinChannel(selectedServerId, name, key);
        } else {
          console.error("No channel specified for /join command");
        }
      } else if (lowerName === "part") {
        const partTarget = args[0] || selectedChannel?.name;
        if (partTarget) {
          useStore.getState().leaveChannel(selectedServerId, partTarget);
        }
      } else if (lowerName === "msg") {
        const [target, ...messageParts] = args;
        const message = messageParts.join(" ");
        const routed = routeOutgoingPM(selectedServerId, target, message);
        if (routed === "withheld") return "withheld" as const;
        if (routed === "sent") return;
        // A message to a service or a line that can carry a password gets no chat and no copy from us, so we never put it on screen ourselves.
        const chat =
          message &&
          !isServicesNick(target) &&
          !message
            .split(LINE_BREAK)
            .some(
              (line) =>
                CREDENTIAL_COMMAND.test(line.trim()) ||
                canCarryPassword(`/msg ${target} ${line}`),
            )
            ? privateChatForOwnMessage(selectedServerId, target)
            : undefined;
        ircClient.sendPrivmsgLines(selectedServerId, target, message);
        if (chat && currentUser)
          showOwnPrivateMessage(
            selectedServerId,
            chat,
            currentUser,
            message,
            null,
          );
      } else if (lowerName === "whisper") {
        const [targetUser, ...messageParts] = args;
        if (!selectedChannel) {
          console.error("Whispers can only be sent from a channel");
          return;
        }
        if (!targetUser || messageParts.length === 0) {
          console.error("Usage: /whisper <username> <message>");
          return;
        }
        const message = messageParts.join(" ");
        ircClient.sendWhisper(
          selectedServerId,
          targetUser,
          selectedChannel.name,
          message,
        );
      } else if (lowerName === "me" || lowerName === "slap") {
        const actionMessage =
          lowerName === "slap"
            ? slapAction(args)
            : cleanedText.substring(4).trim();
        if (actionMessage === null) return;
        const whisperContext = getWhisperContext(localReplyTo, currentUser);
        const target =
          selectedChannel?.name ?? selectedPrivateChat?.username ?? "";
        const actionLines = actionMessage
          .split(/[\r\n]+/)
          .filter(Boolean)
          .flatMap((line) =>
            splitAction(line, whisperContext?.targetUser ?? target),
          )
          .join("\n");
        if (whisperContext) {
          ircClient.sendWhisper(
            selectedServerId,
            whisperContext.targetUser,
            whisperContext.channelContext,
            actionLines,
          );
        } else {
          if (!target) return;
          const soh = String.fromCharCode(1);
          const actionContent = `${soh}ACTION ${actionMessage}${soh}`;
          if (selectedPrivateChat) {
            const routed = routeOutgoingPM(
              selectedServerId,
              selectedPrivateChat.username,
              actionContent,
              localReplyTo?.msgid,
            );
            if (routed === "withheld") return "withheld" as const;
            if (routed === "sent") return;
          }
          ircClient.sendPrivmsgLines(
            selectedServerId,
            target,
            actionLines,
            replyTags(localReplyTo?.msgid),
          );
        }
        if (selectedPrivateChat && currentUser) {
          showOwnPrivateMessage(
            selectedServerId,
            selectedPrivateChat,
            currentUser,
            `\u0001ACTION ${actionMessage}\u0001`,
            localReplyTo,
          );
        }
      } else if (lowerName === "topic") {
        // The topic is the trailing parameter, so a topic with spaces reaches
        // the server whole.
        const rest = command.slice(commandName.length).trimStart();
        const [first = ""] = rest.split(/\s/, 1);
        const named = ircClient.isChannel(selectedServerId, first);
        const channelName = named ? first : selectedChannel?.name;
        if (!channelName) {
          // Outside a channel we send the line as typed, so the server tells the reader why it fails.
          ircClient.sendRaw(selectedServerId, command);
          return;
        }
        const topic = named ? rest.slice(first.length).trimStart() : rest;
        if (topic) ircClient.setTopic(selectedServerId, channelName, topic);
        else ircClient.getTopic(selectedServerId, channelName);
      } else if (lowerName === "away") {
        const message = args.join(" ");
        if (message) {
          setAway(selectedServerId, message);
        } else {
          setAway(selectedServerId);
        }
      } else if (lowerName === "back") {
        clearAway(selectedServerId);
      } else if (lowerName === "motd") {
        ircClient.requestMotd(selectedServerId, args[0]);
      } else if (
        tryDispatchBotCommand(
          selectedServerId,
          selectedChannel,
          selectedPrivateChat,
          commandName,
          args,
        )
      ) {
        // bot-cmd dispatched, nothing else to do
      } else {
        const fullCommand =
          args.length > 0 ? `${commandName} ${args.join(" ")}` : commandName;
        ircClient.sendRaw(
          selectedServerId,
          fullCommand.replace(/[\r\n]+/g, " "),
        );
      }
    },
    [
      selectedServerId,
      selectedChannelId,
      selectedPrivateChatId,
      selectedChannel,
      selectedPrivateChat,
      currentUser,
      localReplyTo,
      setAway,
      clearAway,
    ],
  );

  /**
   * Send a multiline message using BATCH protocol
   */
  const sendMultilineMessage = useCallback(
    (cleanedText: string, target: string, lines: string[], rainbow = false) => {
      if (!selectedServerId) return;

      const whisperContext = getWhisperContext(localReplyTo, currentUser);

      if (whisperContext) {
        lines.forEach((line) => {
          const formattedLine = formatMessageForIrc(line, {
            color: selectedColor || "inherit",
            formatting: selectedFormatting,
          });
          const chunks = rainbow
            ? splitRainbowMessage(formattedLine, whisperContext.targetUser)
            : [formattedLine];
          for (const chunk of chunks) {
            ircClient.sendWhisper(
              selectedServerId,
              whisperContext.targetUser,
              whisperContext.channelContext,
              chunk,
            );
          }
        });
        return;
      }

      const replyPrefix = replyTags(localReplyTo?.msgid);

      const format = (line: string) =>
        formatMessageForIrc(line, {
          color: selectedColor || "inherit",
          formatting: selectedFormatting,
        });

      ircClient.sendMultiline(
        selectedServerId,
        target,
        (lines.length > 1 ? lines : [cleanedText]).map(format),
        replyPrefix,
        rainbow ? splitRainbowToBytes : undefined,
      );
    },
    [
      selectedServerId,
      selectedColor,
      selectedFormatting,
      localReplyTo,
      currentUser,
    ],
  );

  /**
   * Send multiline fallback when server doesn't support BATCH
   */
  const sendMultilineFallback = useCallback(
    (lines: string[], target: string, rainbow = false) => {
      const split: typeof splitLongMessage = rainbow
        ? splitRainbowMessage
        : splitLongMessage;
      if (!selectedServerId) return;

      const whisperContext = getWhisperContext(localReplyTo, currentUser);

      if (whisperContext) {
        lines.forEach((line) => {
          const formattedLine = formatMessageForIrc(line, {
            color: selectedColor || "inherit",
            formatting: selectedFormatting,
          });
          const chunks = rainbow
            ? splitRainbowMessage(formattedLine, whisperContext.targetUser)
            : [formattedLine];
          for (const chunk of chunks) {
            ircClient.sendWhisper(
              selectedServerId,
              whisperContext.targetUser,
              whisperContext.channelContext,
              chunk,
            );
          }
        });
        return;
      }

      const messagePrefix = replyTags(localReplyTo?.msgid);

      if (globalSettings.autoFallbackToSingleLine) {
        const combinedText = lines.join(" ");
        const formattedText = formatMessageForIrc(combinedText, {
          color: selectedColor || "inherit",
          formatting: selectedFormatting,
        });

        const splitLines = split(formattedText, target);
        splitLines.forEach((line: string) => {
          ircClient.sendRaw(
            selectedServerId,
            `${messagePrefix}PRIVMSG ${target} :${line}`,
          );
        });
      } else {
        lines.forEach((line) => {
          const formattedLine = formatMessageForIrc(line, {
            color: selectedColor || "inherit",
            formatting: selectedFormatting,
          });

          const splitLines = split(formattedLine, target);
          splitLines.forEach((splitLine: string) => {
            ircClient.sendRaw(
              selectedServerId,
              `${messagePrefix}PRIVMSG ${target} :${splitLine}`,
            );
          });
        });
      }
    },
    [
      selectedServerId,
      selectedColor,
      selectedFormatting,
      localReplyTo,
      currentUser,
      globalSettings,
    ],
  );

  /**
   * Send a regular single message
   */
  const sendRegularMessage = useCallback(
    (cleanedText: string, target: string, rainbow = false) => {
      const split: typeof splitLongMessage = rainbow
        ? splitRainbowMessage
        : splitLongMessage;
      if (!selectedServerId) return;

      const formattedText = formatMessageForIrc(cleanedText, {
        color: selectedColor || "inherit",
        formatting: selectedFormatting,
      });

      const whisperContext = getWhisperContext(localReplyTo, currentUser);

      // labeled-response: when the cap is acked, we generate one label
      // for the whole send (even when split across multiple PRIVMSGs by
      // splitLongMessage; the spec lets us reuse the same label across
      // them as long as we don't reuse before the response completes).
      const useLabel =
        !whisperContext && shouldUseLabeledResponse(selectedServerId);
      const label = useLabel ? makeLabel() : null;

      // Buffer id for the pending placeholder.  Channels are matched
      // by id from the store; PMs use the PrivateChat record's id.
      const bufferId = selectedChannel
        ? selectedChannel.id
        : selectedPrivateChat
          ? selectedPrivateChat.id
          : null;

      // Insert pending placeholder (only when we have a label *and* a
      // store buffer to put it in -- whisper has neither).
      if (label && bufferId && currentUser && selectedServerId) {
        const placeholder: Message = {
          id: uuidv4(),
          content: cleanedText,
          timestamp: new Date(),
          userId: currentUser.username || currentUser.id,
          channelId: bufferId,
          serverId: selectedServerId,
          type: "message",
          reactions: [],
          replyMessage: localReplyTo,
          mentioned: [],
          pendingLabel: label,
          status: "pending",
        };
        useStore.getState().addMessage(placeholder);
      }

      const replyPrefix = replyTags(localReplyTo?.msgid);
      const tagPrefix = withLabel(replyPrefix, label);

      const outgoingLines = rainbow
        ? splitRainbowMessage(
            formattedText,
            whisperContext?.targetUser ?? target,
          )
        : [formattedText];
      for (const outgoingLine of outgoingLines) {
        sendViaWhisperOrRegular(
          selectedServerId,
          whisperContext,
          outgoingLine,
          (formattedLine) => {
            const splitLines = split(formattedLine, target);
            splitLines.forEach((line: string) => {
              ircClient.sendRaw(
                selectedServerId,
                `${tagPrefix}PRIVMSG ${target} :${line}`,
              );
            });
          },
        );
      }
      if (label && bufferId && currentUser)
        failWhenUnanswered(selectedServerId, () =>
          useStore
            .getState()
            .failPendingMessage(selectedServerId, bufferId, label),
        );
    },
    [
      selectedServerId,
      selectedColor,
      selectedFormatting,
      localReplyTo,
      currentUser,
      selectedChannel,
      selectedPrivateChat,
    ],
  );

  /**
   * Main send message function
   */
  const sendMessage = useCallback(
    (text: string) => {
      let cleanedText = text.replace(/\n+$/, "");
      const rainbow = /^\/rainbow(?:\s|$)/i.test(cleanedText);
      if (rainbow) {
        cleanedText = rainbowText(
          cleanedText.replace(/^\/rainbow(?:\s|$)/i, ""),
          [
            ...(selectedChannel?.users.map((u) => u.username) ?? []),
            ...(selectedPrivateChat ? [selectedPrivateChat.username] : []),
            ...(currentUser ? [currentUser.username] : []),
          ],
        );
      }

      if (cleanedText.trim() === "") return;
      if (!selectedServerId || (!selectedChannelId && !selectedPrivateChatId))
        return;

      // Handle commands
      if (!rainbow && cleanedText.startsWith("/")) {
        return handleCommand(cleanedText);
      }

      // Handle regular messages
      const target =
        selectedChannel?.name ?? selectedPrivateChat?.username ?? "";
      if (!target) return;

      if (
        useStore.getState().servers.find((s) => s.id === selectedServerId)
          ?.isAway
      )
        clearAway(selectedServerId);

      // Route PMs through E2EE before any plaintext send path.
      if (selectedPrivateChat) {
        const routed = routeOutgoingPM(
          selectedServerId,
          selectedPrivateChat.username,
          cleanedText,
          localReplyTo?.msgid,
        );
        if (routed === "withheld") return "withheld" as const;
        if (routed === "sent") return;
      }

      const lines = cleanedText.split(LINE_BREAK);
      const supportsMultiline = serverSupportsMultiline(selectedServerId);
      const hasMultipleLines = lines.length > 1;

      const isSingleLongLine =
        lines.length === 1 && exceedsLineLimit(cleanedText, target);

      // Determine sending strategy
      if (supportsMultiline && (hasMultipleLines || isSingleLongLine)) {
        sendMultilineMessage(cleanedText, target, lines, rainbow);
      } else if (hasMultipleLines && !supportsMultiline) {
        sendMultilineFallback(lines, target, rainbow);
      } else {
        sendRegularMessage(cleanedText, target, rainbow);
      }

      if (selectedPrivateChat && currentUser) {
        showOwnPrivateMessage(
          selectedServerId,
          selectedPrivateChat,
          currentUser,
          cleanedText,
          localReplyTo,
        );
      }
    },
    [
      selectedServerId,
      selectedChannelId,
      selectedPrivateChatId,
      selectedChannel,
      selectedPrivateChat,
      currentUser,
      localReplyTo,
      clearAway,
      handleCommand,
      sendMultilineMessage,
      sendMultilineFallback,
      sendRegularMessage,
    ],
  );

  return {
    sendMessage,
  };
}
