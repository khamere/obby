/**
 * Hook for managing message history navigation with arrow keys
 *
 * ArrowUp on an empty input recalls what the user previously sent, newest
 * first; ArrowDown walks back towards the draft that was in the box.
 *
 * Two sources feed the list:
 *  - everything sent from this input during the session (`recordSent`),
 *    including slash commands and messages the server never echoed, kept
 *    per conversation;
 *  - the user's own messages already in the conversation (e.g. loaded from
 *    chathistory after a reload), appended behind the sent entries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stripIrcFormatting } from "../lib/messageFormatter";
import type { Message } from "../types";

interface UseMessageHistoryOptions {
  messages: Message[];
  currentUsername: string | null;
  /** Identifies the conversation; history is kept separately per key. */
  historyKey: string;
}

interface UseMessageHistoryReturn {
  messageHistoryIndex: number;
  draftText: string;
  navigateUp: (currentText: string) => string | null;
  navigateDown: () => string | null;
  resetHistory: () => void;
  exitHistory: () => void;
  /** Remember a line the user sent, so ArrowUp can bring it back. */
  recordSent: (text: string) => void;
  /** Recallable entries, newest first. */
  userMessageHistory: string[];
}

const MAX_SENT_PER_CONVERSATION = 100;

/**
 * Manages message history navigation for arrow key recall
 */
export function useMessageHistory({
  messages,
  currentUsername,
  historyKey,
}: UseMessageHistoryOptions): UseMessageHistoryReturn {
  const [messageHistoryIndex, setMessageHistoryIndex] = useState(-1);
  const [draftText, setDraftText] = useState("");
  // Sent lines per conversation, newest first. A ref plus a version counter
  // keeps keystroke-time sends from re-rendering anything but the memo below.
  const sentRef = useRef<Map<string, string[]>>(new Map());
  const [sentVersion, setSentVersion] = useState(0);

  const recordSent = useCallback(
    (text: string) => {
      const line = text.trim();
      if (line === "" || !historyKey) return;
      const list = sentRef.current.get(historyKey) ?? [];
      if (list[0] === line) return; // consecutive duplicate
      const next = [line, ...list].slice(0, MAX_SENT_PER_CONVERSATION);
      sentRef.current.set(historyKey, next);
      setSentVersion((v) => v + 1);
    },
    [historyKey],
  );

  // Sent entries first, then own channel messages not already covered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sentVersion invalidates the ref-backed sent list
  const userMessageHistory = useMemo(() => {
    const sent = historyKey ? (sentRef.current.get(historyKey) ?? []) : [];
    if (!currentUsername) return sent;
    const seen = new Set(sent);
    const fromMessages: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== "message" || msg.userId !== currentUsername) continue;
      const line = stripIrcFormatting(msg.content).trim();
      if (line === "" || seen.has(line)) continue;
      seen.add(line);
      fromMessages.push(line);
    }
    return sent.concat(fromMessages);
  }, [messages, currentUsername, historyKey, sentVersion]);

  // Leave history mode when the conversation changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyKey is the trigger, not a value the effect reads
  useEffect(() => {
    setMessageHistoryIndex(-1);
    setDraftText("");
  }, [historyKey]);

  /**
   * Navigate to previous (older) message
   */
  const navigateUp = (currentText: string): string | null => {
    if (userMessageHistory.length === 0) return null;

    // Save draft text on first entry to history mode
    if (messageHistoryIndex === -1 && currentText !== "") {
      setDraftText(currentText);
    }

    // Navigate to previous message (or stay at oldest)
    const newIndex = Math.min(
      messageHistoryIndex + 1,
      userMessageHistory.length - 1,
    );

    if (newIndex >= 0 && newIndex < userMessageHistory.length) {
      setMessageHistoryIndex(newIndex);
      return userMessageHistory[newIndex];
    }

    return null;
  };

  /**
   * Navigate to next (newer) message or exit history mode
   */
  const navigateDown = (): string | null => {
    if (messageHistoryIndex < 0) return null;

    const newIndex = messageHistoryIndex - 1;

    if (newIndex === -1) {
      // Exit history mode, restore draft
      setMessageHistoryIndex(-1);
      const savedDraft = draftText;
      setDraftText("");
      return savedDraft;
    }

    // Navigate to next message
    setMessageHistoryIndex(newIndex);
    return userMessageHistory[newIndex];
  };

  /**
   * Reset history state (called after sending message)
   */
  const resetHistory = (): void => {
    setMessageHistoryIndex(-1);
    setDraftText("");
  };

  /**
   * Exit history mode (called when user starts typing)
   */
  const exitHistory = (): void => {
    if (messageHistoryIndex >= 0) {
      setMessageHistoryIndex(-1);
      setDraftText("");
    }
  };

  return {
    messageHistoryIndex,
    draftText,
    navigateUp,
    navigateDown,
    resetHistory,
    exitHistory,
    recordSent,
    userMessageHistory,
  };
}
