import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  type DraftGate,
  flushDrafts,
  forgetServerDrafts,
  getDraft,
  isStorableDraftText,
  mergeDrafts,
  moveDraft,
  pruneDrafts,
  resetDraftsForTests,
  setDraft,
  startDrafts,
  useHasDraft,
} from "../../src/lib/drafts";

// The shared test setup stubs localStorage with bare spies, so the drafts get
// a real key-value store whose writes we can count.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem = vi.fn((k: string) => this.map.get(k) ?? null);
  setItem = vi.fn((k: string, v: string) => {
    this.map.set(k, String(v));
  });
  removeItem = vi.fn((k: string) => {
    this.map.delete(k);
  });
}

let store: MemoryStorage;
const stored = () => {
  const raw = store.getItem("drafts");
  return raw === null ? null : JSON.parse(raw);
};
const seed = (drafts: unknown) =>
  store.setItem(
    "drafts",
    typeof drafts === "string" ? drafts : JSON.stringify(drafts),
  );
const saveServers = (...ids: string[]) =>
  store.setItem("savedServers", JSON.stringify(ids.map((id) => ({ id }))));
const draftWrites = () =>
  store.setItem.mock.calls.filter(([key]) => key === "drafts");
const allowAll: DraftGate = () => true;

beforeEach(() => {
  vi.useFakeTimers();
  store = new MemoryStorage();
  vi.stubGlobal("localStorage", store);
  resetDraftsForTests();
  saveServers("s1", "s2");
});
afterEach(() => {
  resetDraftsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isStorableDraftText", () => {
  it.each([
    ["hello", true],
    ["", false],
    ["  \n ", false],
    ["/msg NickServ identify hunter2", false],
    ["  /oper a b", false],
    ["/me waves", false],
    ["see /etc/hosts", true],
    ["first line\n// comment", true],
    ["x".repeat(10_000), true],
    ["x".repeat(10_001), false],
  ])("%j -> %s", (text, expected) => {
    expect(isStorableDraftText(text)).toBe(expected);
  });
});

describe("drafts", () => {
  it("names a chat by its server and its name in any letter case", () => {
    setDraft("s1", "#Chan", "hi", 1);
    expect(getDraft("s1", "#chan")).toBe("hi");
    expect(getDraft("s2", "#chan")).toBe("");
  });

  it("writes half a second after the last change", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "#chan", "he", 1000);
    vi.advanceTimersByTime(499);
    expect(stored()).toBeNull();
    setDraft("s1", "#chan", "hello", 1400);
    vi.advanceTimersByTime(499);
    expect(stored()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(stored()).toEqual({ s1: { "#chan": { text: "hello", at: 1400 } } });
  });

  it.each(["", "   "])(
    "removes a draft at once when it becomes %j",
    (blank) => {
      startDrafts(allowAll, 0);
      setDraft("s1", "#chan", "hello", 1400);
      flushDrafts();
      expect(stored()).not.toBeNull();
      setDraft("s1", "#chan", blank, 2000);
      expect(stored()).toBeNull();
      expect(getDraft("s1", "#chan")).toBe("");
    },
  );

  it("leaves a draft alone when the same text is set again", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "#chan", "hello", 1400);
    flushDrafts();
    const writes = draftWrites().length;
    setDraft("s1", "#chan", "hello", 9000);
    flushDrafts();
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({ s1: { "#chan": { text: "hello", at: 1400 } } });
    expect(draftWrites()).toHaveLength(writes);
  });

  it("keeps a command in memory and takes the stored draft away", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "#chan", "hello", 1);
    flushDrafts();
    setDraft("s1", "#chan", "/msg NickServ identify hunter2", 2);
    vi.advanceTimersByTime(500);
    expect(stored()).toBeNull();
    expect(draftWrites().some(([, value]) => value.includes("hunter2"))).toBe(
      false,
    );
    expect(getDraft("s1", "#chan")).toBe("/msg NickServ identify hunter2");
  });

  it("keeps a refused chat's draft in memory only", () => {
    startDrafts((_s, name) => name !== "bob", 0);
    setDraft("s1", "bob", "secret", 1);
    vi.advanceTimersByTime(500);
    expect(stored()).toBeNull();
    expect(getDraft("s1", "bob")).toBe("secret");
    const { result } = renderHook(() => useHasDraft("s1", "bob"));
    expect(result.current).toBe(true);
  });

  it("removes a stored draft once its chat is refused, and stores it again only after an edit", () => {
    let isBobAllowed = true;
    startDrafts((_s, name) => name !== "bob" || isBobAllowed, 0);
    setDraft("s1", "bob", "plain", 1);
    setDraft("s1", "#chan", "hello", 2);
    flushDrafts();
    expect(Object.keys(stored().s1)).toEqual(["bob", "#chan"]);

    isBobAllowed = false;
    flushDrafts();
    expect(stored()).toEqual({ s1: { "#chan": { text: "hello", at: 2 } } });
    expect(getDraft("s1", "bob")).toBe("plain");

    isBobAllowed = true;
    flushDrafts();
    expect(stored().s1.bob).toBeUndefined();

    setDraft("s1", "bob", "plain!", 3);
    vi.advanceTimersByTime(500);
    expect(stored().s1.bob).toEqual({ text: "plain!", at: 3 });
  });

  it("keeps text typed in a refused chat off disk when the chat is allowed before the write", () => {
    let isBobAllowed = false;
    startDrafts((_s, name) => name !== "bob" || isBobAllowed, 0);
    setDraft("s1", "bob", "typed under the lock", 1);
    isBobAllowed = true;
    flushDrafts();
    vi.advanceTimersByTime(500);
    expect(stored()).toBeNull();
    expect(getDraft("s1", "bob")).toBe("typed under the lock");
  });

  it("changes only the chats this tab edited", () => {
    startDrafts(allowAll, 0);
    seed({ s1: { "#other": { text: "theirs", at: 5 } } });
    setDraft("s1", "#mine", "mine", 10);
    flushDrafts();
    expect(stored()).toEqual({
      s1: {
        "#other": { text: "theirs", at: 5 },
        "#mine": { text: "mine", at: 10 },
      },
    });

    seed({
      s1: {
        "#other": { text: "theirs, newer", at: 20 },
        "#mine": { text: "mine", at: 10 },
      },
    });
    flushDrafts();
    expect(stored().s1["#other"]).toEqual({ text: "theirs, newer", at: 20 });
  });

  it("moves a stored draft to the chat's new name", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "alice", "hi", 7);
    flushDrafts();

    moveDraft("s1", "alice", "ALICE");
    expect(stored()).toEqual({ s1: { alice: { text: "hi", at: 7 } } });

    moveDraft("s1", "alice", "Alice_");
    expect(getDraft("s1", "alice")).toBe("");
    expect(getDraft("s1", "alice_")).toBe("hi");
    expect(stored()).toEqual({ s1: { alice_: { text: "hi", at: 7 } } });
  });

  it("leaves the new name's draft alone when the old name has none", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "bob", "old", 1);
    flushDrafts();
    moveDraft("s1", "alice", "bob");
    expect(getDraft("s1", "bob")).toBe("old");
    expect(stored()).toEqual({ s1: { bob: { text: "old", at: 1 } } });
  });

  it("moves a draft that was never stored in memory only", () => {
    startDrafts((_s, name) => name !== "alice", 0);
    setDraft("s1", "alice", "hi", 1);
    vi.advanceTimersByTime(500);
    moveDraft("s1", "alice", "alice_");
    expect(getDraft("s1", "alice_")).toBe("hi");
    vi.advanceTimersByTime(500);
    flushDrafts();
    expect(stored()).toBeNull();

    setDraft("s1", "alice_", "hi!", 2);
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({ s1: { alice_: { text: "hi!", at: 2 } } });
  });

  it("lets the moved draft replace the one under the new name", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "alice", "mine", 1);
    setDraft("s1", "bob", "old", 2);
    flushDrafts();
    moveDraft("s1", "alice", "bob");
    expect(getDraft("s1", "bob")).toBe("mine");
    expect(stored()).toEqual({ s1: { bob: { text: "mine", at: 1 } } });
  });

  it("removes the stored draft under the new name when the moved one was never stored", () => {
    startDrafts((_s, name) => name !== "alice", 0);
    setDraft("s1", "alice", "mine", 1);
    setDraft("s1", "bob", "old", 2);
    flushDrafts();
    expect(stored()).toEqual({ s1: { bob: { text: "old", at: 2 } } });
    moveDraft("s1", "alice", "bob");
    expect(getDraft("s1", "bob")).toBe("mine");
    expect(stored()).toBeNull();
    flushDrafts();
    expect(stored()).toBeNull();
  });

  it("forgets a server's drafts in memory and storage", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "#a", "one", 1);
    setDraft("s2", "#b", "two", 2);
    flushDrafts();
    seed({
      ...stored(),
      s1: { ...stored().s1, "#tab": { text: "another tab", at: 3 } },
    });
    setDraft("s1", "#a", "one, edited", 4);

    forgetServerDrafts("s1");

    expect(stored()).toEqual({ s2: { "#b": { text: "two", at: 2 } } });
    expect(getDraft("s1", "#a")).toBe("");
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({ s2: { "#b": { text: "two", at: 2 } } });
  });

  it("prunes old drafts, drafts of unknown servers and commands", () => {
    const now = 1_000_000_000_000;
    const saved = {
      s1: {
        "#old": { text: "too old", at: now - DRAFT_MAX_AGE_MS - 1 },
        "#edge": { text: "just in time", at: now - DRAFT_MAX_AGE_MS },
        "#cmd": { text: "/me waves", at: now },
      },
      gone: { "#chan": { text: "orphan", at: now } },
    };
    expect(pruneDrafts(saved, new Set(["s1"]), now)).toEqual({
      s1: { "#edge": { text: "just in time", at: now - DRAFT_MAX_AGE_MS } },
    });
    expect(Object.keys(pruneDrafts(saved, null, now))).toEqual(["s1", "gone"]);
  });

  it("restores the stored drafts of saved servers at start", () => {
    seed({ s1: { "#chan": { text: "restored", at: 5 } } });
    startDrafts(allowAll, 10);
    expect(getDraft("s1", "#chan")).toBe("restored");
    const { result } = renderHook(() => useHasDraft("s1", "#Chan"));
    expect(result.current).toBe(true);
    expect(draftWrites()).toHaveLength(1);
  });

  it("drops the drafts of servers that are no longer saved at start", () => {
    seed({ s1: { "#chan": { text: "restored", at: 5 } } });
    saveServers();
    startDrafts(allowAll, 10);
    expect(getDraft("s1", "#chan")).toBe("");
    expect(stored()).toBeNull();
  });

  it("drops a stored draft at start when its chat is refused", () => {
    seed({ s1: { bob: { text: "restored", at: 5 } } });
    startDrafts(() => false, 10);
    expect(getDraft("s1", "bob")).toBe("");
    expect(stored()).toBeNull();
  });

  it("stores the fifty drafts edited last", () => {
    startDrafts(allowAll, 0);
    for (let i = 1; i <= 51; i++) setDraft("s1", `#c${i}`, `draft ${i}`, i);
    flushDrafts();
    const kept = Object.values(stored().s1) as { at: number }[];
    expect(kept).toHaveLength(50);
    expect(kept.some((entry) => entry.at === 1)).toBe(false);
    expect(getDraft("s1", "#c1")).toBe("draft 1");
    expect(getDraft("s1", "#c51")).toBe("draft 51");
  });

  it("tries a failed write again at the next flush", () => {
    startDrafts(allowAll, 0);
    store.setItem.mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    setDraft("s1", "#chan", "hello", 1);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(store.removeItem).not.toHaveBeenCalledWith("drafts");
    expect(stored()).toBeNull();
    expect(getDraft("s1", "#chan")).toBe("hello");

    flushDrafts();
    expect(stored()).toEqual({ s1: { "#chan": { text: "hello", at: 1 } } });
  });

  it.each([
    ["text that is no JSON", "not json"],
    ["a server that is no object", { s1: "x" }],
    ["a text that is no string", { s1: { "#chan": { text: 5, at: 1 } } }],
    ["an entry without a time", { s1: { "#chan": { text: "hi" } } }],
    ["a list", [1, 2]],
  ])("reads %s as no drafts", (_case, data) => {
    seed(data);
    expect(() => startDrafts(allowAll, 10)).not.toThrow();
    expect(getDraft("s1", "#chan")).toBe("");
  });

  it("starts with no drafts when storage answers undefined", () => {
    store.getItem.mockReturnValue(undefined as unknown as null);
    expect(() => startDrafts(allowAll, 10)).not.toThrow();
    expect(getDraft("s1", "#chan")).toBe("");
  });

  it("replaces unreadable stored data with the next draft", () => {
    seed("garbage");
    startDrafts(allowAll, 0);
    setDraft("s1", "#chan", "hello", 1);
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({ s1: { "#chan": { text: "hello", at: 1 } } });
  });

  it("stores a draft for a nick spelled like an object property", () => {
    startDrafts(allowAll, 0);
    setDraft("s1", "__proto__", "hi", 1);
    setDraft("s1", "constructor", "there", 2);
    flushDrafts();
    resetDraftsForTests();
    startDrafts(allowAll, 3);
    expect(getDraft("s1", "__proto__")).toBe("hi");
    expect(getDraft("s1", "constructor")).toBe("there");
    expect(getDraft("s1", "tostring")).toBe("");
  });

  it("tells a row when its chat gains or loses a draft", () => {
    const { result } = renderHook(() => useHasDraft("s1", "#chan"));
    expect(result.current).toBe(false);
    act(() => setDraft("s1", "#Chan", "x", 1));
    expect(result.current).toBe(true);
    act(() => setDraft("s1", "#chan", "", 2));
    expect(result.current).toBe(false);
  });

  it("writes nothing before the app has handed over its rules", () => {
    seed({ s1: { "#other": { text: "stored", at: 5 } } });
    const writes = draftWrites().length;
    setDraft("s1", "#chan", "early", 1);
    vi.advanceTimersByTime(500);
    setDraft("s1", "#chan", "", 2);
    expect(getDraft("s1", "#chan")).toBe("");
    setDraft("s1", "#chan", "early again", 3);
    vi.advanceTimersByTime(500);
    expect(getDraft("s1", "#chan")).toBe("early again");
    expect(draftWrites()).toHaveLength(writes);
    expect(store.removeItem).not.toHaveBeenCalledWith("drafts");
  });
});

describe("mergeDrafts", () => {
  it("turns a refused or unstorable change into a removal and drops what the rules refuse", () => {
    const saved = {
      s1: {
        "#keep": { text: "kept", at: 1 },
        "#gone": { text: "sent", at: 2 },
        bob: { text: "now refused", at: 3 },
        "#cmd": { text: "old text", at: 4 },
      },
    };
    const changes = new Map([
      [
        "s1",
        new Map([
          ["#gone", null],
          ["#cmd", { text: "/join #c key", at: 9 }],
          ["#new", { text: "fresh", at: 10 }],
        ]),
      ],
      ["s2", new Map([["alice", null]])],
    ]);
    expect(mergeDrafts(saved, changes, (_s, name) => name !== "bob")).toEqual({
      s1: {
        "#keep": { text: "kept", at: 1 },
        "#new": { text: "fresh", at: 10 },
      },
    });
  });
});
