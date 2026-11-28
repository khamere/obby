import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDraft,
  resetDraftsForTests,
  setDraft,
  startDrafts,
} from "../../src/lib/drafts";
import { obbyPeerTrust } from "../../src/lib/e2ee/obbyIdentity";
import {
  type E2EESessionState,
  e2eeSessionKey,
} from "../../src/lib/e2ee/session";
import ircClient from "../../src/lib/ircClient";
import useStore, { type AppState } from "../../src/store";
import { mayStoreDraft } from "../../src/store/handlers/drafts";
import type { Server } from "../../src/types";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const serverId = "s1";

const stored = () => JSON.parse(lsBacking.get("drafts") ?? "null");
const everStored = () =>
  vi
    .mocked(localStorage.setItem)
    .mock.calls.filter(([key]) => key === "drafts")
    .map(([, value]) => value)
    .join("\n");
const settle = () => vi.advanceTimersByTime(500);
const type = (name: string, text: string, id = serverId) => {
  setDraft(id, name, text);
  settle();
};
const setSession = (nick: string, session: E2EESessionState) =>
  useStore.setState((state) => ({
    e2eeSessions: {
      ...state.e2eeSessions,
      [e2eeSessionKey(serverId, nick)]: session,
    },
  }));
const setKeepHistory = (keepHistory: boolean) =>
  useStore.setState((state) => ({
    globalSettings: { ...state.globalSettings, keepHistory },
  }));
const feed = (line: string) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(line, serverId);

function seedServer(server: Partial<Server> = {}) {
  ircClient.nicks.set(serverId, "me");
  const full = {
    id: serverId,
    name: "Example",
    host: "irc.example.org",
    port: 6697,
    isConnected: true,
    users: [],
    channels: [],
    privateChats: [],
    ...server,
  } as unknown as Server;
  useStore.setState({
    servers: [full],
    messages: {},
    activeBatches: {},
    e2eeSessions: {},
  } as Partial<AppState>);
}

describe("drafts on disk follow the rules of saved history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorageBacking();
    vi.mocked(localStorage.setItem).mockClear();
    lsBacking.set("savedServers", JSON.stringify([{ id: serverId }]));
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seedServer();
    setKeepHistory(true);
    resetDraftsForTests();
    startDrafts(mayStoreDraft(useStore));
  });
  afterEach(() => {
    resetDraftsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    lsBacking.clear();
    ircClient.nicks.delete(serverId);
    useStore.setState({ servers: [], e2eeSessions: {} } as Partial<AppState>);
  });

  it("stores channel drafts, also for a channel named like a service", () => {
    type("#chan", "hello");
    type("#observ", "watching");
    expect(Object.keys(stored()[serverId])).toEqual(["#chan", "#observ"]);
  });

  it.each(["NickServ", "BouncerServ"])(
    "keeps a draft to %s in memory only",
    (nick) => {
      type(nick, "network status");
      expect(stored()).toBeNull();
      expect(getDraft(serverId, nick)).toBe("network status");
    },
  );

  it.each(["identify hunter2", "hi\nlogin a hunter2"])(
    "keeps the private password line %j off disk",
    (text) => {
      type("authbot", text);
      expect(stored()).toBeNull();
      expect(everStored()).not.toContain("hunter2");
    },
  );

  it("stores the same line in a channel, as saved history does", () => {
    type("#chan", "identify hunter2");
    expect(stored()[serverId]["#chan"].text).toBe("identify hunter2");
  });

  it.each<E2EESessionState>([
    { status: "negotiating", scheme: "obby", initiator: true },
    {
      status: "established",
      scheme: "obby",
      verified: false,
      peerFingerprint: "f",
    },
  ])(
    "keeps a draft off disk while the chat's session is $status",
    (session) => {
      setSession("Bob", session);
      type("bob", "secret plan");
      expect(stored()).toBeNull();
      expect(everStored()).not.toContain("secret plan");
    },
  );

  it.each<E2EESessionState>([
    { status: "none" },
    { status: "rejected", scheme: "obby" },
  ])("stores a draft while the chat's session is $status", (session) => {
    setSession("bob", session);
    type("bob", "plain");
    expect(stored()[serverId].bob.text).toBe("plain");
  });

  it("removes a stored draft as soon as its chat is encrypted", () => {
    type("bob", "plain draft");
    type("#chan", "hello");
    expect(stored()[serverId].bob).toBeDefined();

    setSession("bob", {
      status: "negotiating",
      scheme: "obby",
      initiator: true,
    });

    expect(Object.keys(stored()[serverId])).toEqual(["#chan"]);
    expect(getDraft(serverId, "bob")).toBe("plain draft");

    setSession("bob", { status: "none" });
    settle();
    expect(Object.keys(stored()[serverId])).toEqual(["#chan"]);
  });

  it("keeps drafts to a peer whose encryption comes back by itself off disk", () => {
    obbyPeerTrust.pin(serverId, "bob", "fingerprint");
    type("bob", "plain");
    expect(stored()).toBeNull();

    obbyPeerTrust.setAutoResume(serverId, "bob", false);
    type("bob", "plain!");
    expect(stored()[serverId].bob.text).toBe("plain!");
  });

  it("stores nothing while history is turned off", () => {
    setKeepHistory(false);
    type("#chan", "hello");
    expect(stored()).toBeNull();
  });

  it("removes the stored drafts when history is turned off and stores them again after an edit", () => {
    type("#chan", "hello");
    type("bob", "plain");
    setKeepHistory(false);
    expect(lsBacking.has("drafts")).toBe(false);
    expect(getDraft(serverId, "#chan")).toBe("hello");
    expect(getDraft(serverId, "bob")).toBe("plain");

    setKeepHistory(true);
    settle();
    expect(lsBacking.has("drafts")).toBe(false);

    type("#chan", "hello again");
    expect(stored()).toEqual({
      [serverId]: { "#chan": expect.objectContaining({ text: "hello again" }) },
    });
  });

  it("drops the drafts of a removed bouncer and of its networks", () => {
    const saved = [
      { id: "control", name: "bouncer", host: "h", port: 1, channels: [] },
      {
        id: "network",
        name: "net",
        host: "h",
        port: 1,
        channels: [],
        bouncerServerId: "control",
        bouncerNetid: "1",
      },
      { id: serverId, name: "direct", host: "d", port: 1, channels: [] },
    ];
    lsBacking.set("savedServers", JSON.stringify(saved));
    useStore.setState({
      servers: saved.map((s) => ({
        ...s,
        privateChats: [],
        users: [],
        isConnected: true,
      })),
    } as unknown as Partial<AppState>);
    vi.spyOn(ircClient, "removeServer").mockImplementation(() => {});
    type("#test", "on the control entry", "control");
    type("#test", "on the network", "network");
    type("#test", "on the direct server");
    expect(Object.keys(stored())).toEqual(["control", "network", serverId]);

    useStore.getState().deleteServer("control");

    expect(Object.keys(stored())).toEqual([serverId]);
    expect(getDraft("control", "#test")).toBe("");
    expect(getDraft("network", "#test")).toBe("");
    expect(getDraft(serverId, "#test")).toBe("on the direct server");
  });

  it("drops the draft of a channel the user left", () => {
    seedServer({
      channels: [{ id: "c1", name: "#chan", users: [] }],
    } as unknown as Partial<Server>);
    type("#chan", "hello");
    useStore.getState().forgetChannel(serverId, "#Chan");
    expect(stored()).toBeNull();
    expect(getDraft(serverId, "#chan")).toBe("");
  });

  it("drops the draft of a private chat the user closed", () => {
    seedServer({
      privateChats: [{ id: "p1", username: "Bob", serverId }],
    } as unknown as Partial<Server>);
    type("bob", "plain");
    type("#chan", "hello");
    useStore.getState().deletePrivateChat(serverId, "p1");
    expect(Object.keys(stored()[serverId])).toEqual(["#chan"]);
    expect(getDraft(serverId, "bob")).toBe("");
  });

  it("moves a draft along with a nick change", () => {
    seedServer({
      privateChats: [{ id: "p1", username: "alice", serverId }],
    } as unknown as Partial<Server>);
    type("alice", "hi");
    feed(":alice!u@h NICK alice_");
    expect(getDraft(serverId, "alice")).toBe("");
    expect(getDraft(serverId, "alice_")).toBe("hi");
    expect(Object.keys(stored()[serverId])).toEqual(["alice_"]);
  });

  it("leaves a draft alone on a nick change replayed from history", () => {
    seedServer({
      privateChats: [{ id: "p1", username: "alice", serverId }],
    } as unknown as Partial<Server>);
    useStore.setState({
      activeBatches: {
        [serverId]: {
          b1: {
            type: "chathistory",
            parameters: ["#chan"],
            events: [],
            startTime: new Date(0),
          },
        },
      },
    } as Partial<AppState>);
    type("alice", "hi");
    feed("@batch=b1 :alice!u@h NICK alice_");
    expect(getDraft(serverId, "alice")).toBe("hi");
    expect(getDraft(serverId, "alice_")).toBe("");
  });

  it("moves a draft along with a channel rename", () => {
    seedServer({
      channels: [{ id: "c1", name: "#old", users: [] }],
    } as unknown as Partial<Server>);
    type("#old", "hello");
    feed(":op!u@h RENAME #old #new :tidying up");
    expect(getDraft(serverId, "#old")).toBe("");
    expect(getDraft(serverId, "#new")).toBe("hello");
    expect(Object.keys(stored()[serverId])).toEqual(["#new"]);
  });
});
