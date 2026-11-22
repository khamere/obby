import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore, {
  type AppState,
  NETWORK_DELETE_WAIT_MS,
} from "../../src/store";
import * as history from "../../src/store/handlers/history";
import { generateDeterministicId } from "../../src/store/helpers";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const PARENT = "bnc";
const NETID = "42";
const CHILD = generateDeterministicId(PARENT, NETID);

function seed(isControlUp: boolean) {
  installLocalStorageBacking();
  const base = {
    host: "wss://bouncer.example",
    port: 6697,
    channels: [],
    privateChats: [],
    users: [],
  };
  useStore.setState((state) => ({
    servers: [
      {
        ...base,
        id: PARENT,
        name: "bouncer",
        isBouncerControl: true,
        isConnected: isControlUp,
        isRegistered: isControlUp,
        connectionState: isControlUp ? "connected" : "reconnecting",
      },
      {
        ...base,
        id: CHILD,
        name: "Net",
        bouncerServerId: PARENT,
        bouncerNetid: NETID,
        isConnected: true,
        connectionState: "connected",
      },
    ],
    bouncers: {
      [PARENT]: {
        serverId: PARENT,
        supported: true,
        notifyEnabled: true,
        listed: true,
        networks: {
          [NETID]: {
            netid: NETID,
            attributes: { name: "Net", host: "irc.example" },
          },
        },
      },
    },
    pendingNetworkDeletes: {},
    ui: { ...state.ui, disconnectNetworkConfirmTarget: null },
  })) as unknown as Partial<AppState>;
}

const SAVED_CHILD = {
  id: CHILD,
  name: "Net",
  host: "wss://bouncer.example",
  port: 6697,
  nickname: "me",
  channels: [],
  bouncerServerId: PARENT,
  bouncerNetid: NETID,
};

// The bouncer's whole network list, as it sends it after a login.
function openBatch(type: string) {
  ircClient.triggerEvent("BATCH_START", {
    serverId: PARENT,
    batchId: "list",
    type,
    parameters: [],
    sender: "bouncer.example",
  });
}

function listNetwork(netid: string, host = "irc.example") {
  ircClient.triggerEvent("BOUNCER_NETWORK", {
    serverId: PARENT,
    netid,
    deleted: false,
    attributes: { name: "Net", host },
    batchTag: "list",
  });
}

const closeBatch = () =>
  ircClient.triggerEvent("BATCH_END", { serverId: PARENT, batchId: "list" });

function listNetworks(netids: string[]) {
  openBatch("soju.im/bouncer-networks");
  for (const netid of netids) listNetwork(netid);
  closeBatch();
}

const dropControl = () =>
  ircClient.triggerEvent("connectionStateChange", {
    serverId: PARENT,
    connectionState: "reconnecting",
  });

const target = () => useStore.getState().ui.disconnectNetworkConfirmTarget;
const hasChild = () => useStore.getState().servers.some((s) => s.id === CHILD);

describe("deleting a bouncer network", () => {
  let delNetwork: ReturnType<typeof vi.spyOn>;
  let settle: ReturnType<typeof vi.spyOn>;
  let listRequest: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(ircClient, "removeServer").mockImplementation(() => {});
    delNetwork = vi
      .spyOn(ircClient, "bouncerDelNetwork")
      .mockImplementation(() => {});
    settle = vi.spyOn(history, "settleSavedHistory").mockResolvedValue();
    listRequest = vi
      .spyOn(ircClient, "bouncerListNetworks")
      .mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    lsBacking.clear();
    useStore.setState((state) => ({
      servers: [],
      bouncers: {},
      pendingNetworkDeletes: {},
      ui: { ...state.ui, disconnectNetworkConfirmTarget: null },
    }));
  });

  test("keeps the network until the bouncer acknowledges the delete", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);

    expect(delNetwork).toHaveBeenCalledExactlyOnceWith(PARENT, NETID);
    expect(hasChild()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(target()?.status).toBe("deleting");

    ircClient.triggerEvent("BOUNCER_NETWORK", {
      serverId: PARENT,
      netid: NETID,
      deleted: true,
      attributes: {},
    });

    // The bouncer's deleted line on this session is its answer to a waiting
    // delete, whichever device caused it: the network is gone, as asked.
    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );
    expect(target()).toBeNull();
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});

    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(settle).toHaveBeenCalledOnce();
    expect(target()).toBeNull();
  });

  test("settles a waiting delete on the deleted line and ignores the refusal that follows", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_NETWORK", {
      serverId: PARENT,
      netid: NETID,
      deleted: true,
      attributes: {},
    });

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );

    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INVALID_NETID",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Invalid network ID",
    });

    expect(settle).toHaveBeenCalledOnce();
    expect(target()).toBeNull();
  });

  test("removes the network on the acknowledgement alone", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(false);
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(hasChild()).toBe(false);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBe(
      undefined,
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
    expect(target()).toBeNull();
  });

  test("sends nothing while the control connection is down", () => {
    seed(false);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);

    expect(delNetwork).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(hasChild()).toBe(true);
    expect(target()).toMatchObject({ netid: NETID });
    expect(target()?.status).toBeUndefined();
  });

  test("keeps the network and reports it when the bouncer refuses", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INTERNAL_ERROR",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Not allowed",
    });

    expect(hasChild()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(target()?.status).toBe("refused");
    expect(target()?.refusal).toBe("Not allowed");
  });

  test("leaves the dialog alone when another command fails", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INVALID_ATTRIBUTE",
      subcommand: "CHANGENETWORK",
      netid: "7",
      context: ["7", "host"],
      description: "Invalid host",
    });

    expect(target()?.status).toBe("deleting");
  });

  test("stops waiting when the control connection drops", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();

    expect(hasChild()).toBe(true);
    expect(target()).toMatchObject({ netid: NETID, status: "unanswered" });
    expect(useStore.getState().bouncers[PARENT].isListStale).toBe(true);
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
  });

  test("keeps the saved history when only the network list shows a lost delete went through", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();
    listNetworks(["7"]);

    expect(hasChild()).toBe(false);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBe(
      undefined,
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
    expect(target()).toBeNull();
  });

  test("keeps the saved history when the acknowledgement arrives on a later session", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
  });

  test("keeps the saved history of a network the list of another login lacks", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    useStore.getState().cancelDisconnectNetwork();
    ircClient.triggerEvent("connectionStateChange", {
      serverId: PARENT,
      connectionState: "disconnected",
    });
    listNetworks([]);

    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
  });

  test("keeps the saved history of a network another device deleted", () => {
    seed(true);
    ircClient.triggerEvent("BOUNCER_NETWORK", {
      serverId: PARENT,
      netid: NETID,
      deleted: true,
      attributes: {},
    });

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
  });

  test("keeps a network the list still has after a lost answer", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("connectionStateChange", {
      serverId: PARENT,
      connectionState: "reconnecting",
    });
    listNetworks([NETID]);

    expect(hasChild()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(target()?.status).toBe("unanswered");
    expect(useStore.getState().bouncers[PARENT].isListStale).toBe(false);
  });

  test("keeps every network when a list is cut short and its batch reference comes back as another batch", () => {
    seed(true);
    openBatch("soju.im/bouncer-networks");
    listNetwork("7");
    dropControl();
    openBatch("draft/isupport");
    closeBatch();

    expect(hasChild()).toBe(true);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBeDefined();
  });

  test("keeps every network when a cut-short list is followed by the end of a batch that never opened", () => {
    seed(true);
    openBatch("soju.im/bouncer-networks");
    listNetwork("7");
    dropControl();
    closeBatch();

    expect(hasChild()).toBe(true);
  });

  test("applies the history choice when the dialog was closed before the bouncer acknowledged", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    useStore.getState().cancelDisconnectNetwork();
    expect(target()).toBeNull();
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
  });

  test("reopens a waiting delete as it was sent and sends nothing more", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    useStore.getState().cancelDisconnectNetwork();
    useStore.getState().requestDeleteServer(CHILD);

    expect(target()).toMatchObject({
      status: "deleting",
      shouldDeleteHistory: true,
    });
    useStore.getState().confirmDisconnectNetwork(false);
    expect(delNetwork).toHaveBeenCalledOnce();
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );
  });

  test("treats a network the bouncer does not know as already gone and keeps its history", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INVALID_NETID",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Invalid network ID",
    });

    expect(target()).toBeNull();
    expect(hasChild()).toBe(false);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBe(
      undefined,
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
  });

  test("shows a refusal that names no network on the one waiting delete", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "UNKNOWN_COMMAND",
      subcommand: "DELNETWORK",
      context: [],
      description: "Unknown subcommand",
    });

    expect(target()).toMatchObject({
      status: "refused",
      refusal: "Unknown subcommand",
    });
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
  });

  test("forgets a refused delete", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INTERNAL_ERROR",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Not allowed",
    });

    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
  });

  test("asks a bouncer without the notify capability for its list after the next login", () => {
    seed(true);
    useStore.setState((state) => ({
      bouncers: {
        [PARENT]: { ...state.bouncers[PARENT], notifyEnabled: false },
      },
    }));
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();
    expect(listRequest).not.toHaveBeenCalled();
    ircClient.triggerEvent("ready", {
      serverId: PARENT,
      serverName: "bouncer.example",
      nickname: "me",
    });

    expect(listRequest).toHaveBeenCalledExactlyOnceWith(PARENT);
  });

  test("asks for no list after a login without an open delete", () => {
    seed(true);
    useStore.setState((state) => ({
      bouncers: {
        [PARENT]: { ...state.bouncers[PARENT], notifyEnabled: false },
      },
    }));
    ircClient.triggerEvent("ready", {
      serverId: PARENT,
      serverName: "bouncer.example",
      nickname: "me",
    });

    expect(listRequest).not.toHaveBeenCalled();
  });

  const logIn = () =>
    useStore.setState((state) => ({
      servers: state.servers.map((server) =>
        server.id === PARENT
          ? { ...server, isConnected: true, isRegistered: true }
          : server,
      ),
    }));

  test("sends nothing from a dialog reopened after a reconnect until the list has arrived", () => {
    seed(true);
    dropControl();
    logIn();
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);

    expect(delNetwork).not.toHaveBeenCalled();
    expect(target()?.status).toBeUndefined();
    listNetworks([NETID]);
    useStore.getState().confirmDisconnectNetwork(true);
    expect(delNetwork).toHaveBeenCalledExactlyOnceWith(PARENT, NETID);
  });

  test("sends nothing and closes a reopened dialog when the list shows another network under the id", () => {
    seed(true);
    dropControl();
    logIn();
    useStore.getState().requestDeleteServer(CHILD);
    openBatch("soju.im/bouncer-networks");
    listNetwork(NETID, "irc.other.example");
    closeBatch();

    expect(target()).toBeNull();
    useStore.getState().confirmDisconnectNetwork(true);
    expect(delNetwork).not.toHaveBeenCalled();
    expect(hasChild()).toBe(true);
  });

  test("keeps a dialog opened before the first list and takes the network from that list", () => {
    seed(true);
    useStore.setState((state) => ({
      bouncers: { [PARENT]: { ...state.bouncers[PARENT], networks: {} } },
    }));
    useStore.getState().requestDeleteBouncerNetwork(PARENT, NETID);
    expect(target()?.identity).toBeUndefined();
    listNetworks([NETID]);

    expect(target()).toMatchObject({
      netid: NETID,
      identity: "Net\nirc.example\n",
    });
    useStore.getState().confirmDisconnectNetwork(false);
    expect(delNetwork).toHaveBeenCalledExactlyOnceWith(PARENT, NETID);
  });

  test("keeps the saved history when a list on the same session lacks the network while its delete still waits", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    listNetworks(["7"]);

    expect(hasChild()).toBe(false);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBe(
      undefined,
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
    expect(target()).toBeNull();
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
  });

  test("sends nothing and closes the dialog when the network changed under it", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    ircClient.triggerEvent("BOUNCER_NETWORK", {
      serverId: PARENT,
      netid: NETID,
      deleted: false,
      attributes: { host: "irc.other.example" },
    });
    useStore.getState().confirmDisconnectNetwork(true);

    expect(delNetwork).not.toHaveBeenCalled();
    expect(target()).toBeNull();
  });

  test("asks a bouncer without the notify capability for its list at every login until one has arrived", () => {
    seed(true);
    useStore.setState((state) => ({
      bouncers: {
        [PARENT]: { ...state.bouncers[PARENT], notifyEnabled: false },
      },
    }));
    const ready = () =>
      ircClient.triggerEvent("ready", {
        serverId: PARENT,
        serverName: "bouncer.example",
        nickname: "me",
      });
    dropControl();
    ready();
    openBatch("soju.im/bouncer-networks");
    dropControl();
    ready();
    expect(listRequest).toHaveBeenCalledTimes(2);
    listNetworks([NETID]);
    ready();

    expect(listRequest).toHaveBeenCalledTimes(2);
  });

  test("offers no second delete until the list after a dropped connection has arrived", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();
    useStore.getState().confirmDisconnectNetwork(true);
    logIn();
    useStore.getState().confirmDisconnectNetwork(true);
    expect(delNetwork).toHaveBeenCalledOnce();
    listNetworks([NETID]);
    useStore.getState().confirmDisconnectNetwork(false);

    expect(delNetwork).toHaveBeenCalledTimes(2);
    expect(target()).toMatchObject({
      status: "deleting",
      shouldDeleteHistory: false,
    });
  });

  test("closes the dialog without touching a different network that took over the id", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    dropControl();
    openBatch("soju.im/bouncer-networks");
    listNetwork(NETID, "irc.other.example");
    closeBatch();

    expect(target()).toBeNull();
    expect(settle).not.toHaveBeenCalled();
    expect(hasChild()).toBe(true);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBeDefined();
    expect(delNetwork).toHaveBeenCalledOnce();
  });

  test("stops waiting for an answer that never comes, asks for the list and offers the delete again", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    vi.advanceTimersByTime(NETWORK_DELETE_WAIT_MS - 1);
    expect(target()?.status).toBe("deleting");
    vi.advanceTimersByTime(1);

    expect(target()?.status).toBe("unanswered");
    expect(useStore.getState().bouncers[PARENT].isListStale).toBeFalsy();
    expect(useStore.getState().pendingNetworkDeletes).toEqual({});
    expect(listRequest).toHaveBeenCalledExactlyOnceWith(PARENT);
    expect(hasChild()).toBe(true);
    useStore.getState().confirmDisconnectNetwork(true);
    expect(delNetwork).toHaveBeenCalledTimes(2);
  });

  test("keeps the saved history when a list shows the network gone after the wait ran out", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    vi.advanceTimersByTime(NETWORK_DELETE_WAIT_MS);
    listNetworks(["7"]);

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      false,
    );
  });

  test("leaves an answered delete alone when the wait runs out", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INTERNAL_ERROR",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Not allowed",
    });
    vi.advanceTimersByTime(NETWORK_DELETE_WAIT_MS);

    expect(target()?.status).toBe("refused");
    expect(listRequest).not.toHaveBeenCalled();
  });

  test("sends nothing before the control connection has logged in", () => {
    seed(true);
    useStore.setState((state) => ({
      servers: state.servers.map((s) =>
        s.id === PARENT ? { ...s, isRegistered: false } : s,
      ),
    }));
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);

    expect(delNetwork).not.toHaveBeenCalled();
    expect(target()?.status).toBeUndefined();
  });

  test("ignores a refusal that names another network", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INVALID_NETID",
      subcommand: "DELNETWORK",
      netid: "7",
      context: ["7"],
      description: "Invalid network ID",
    });

    expect(target()?.status).toBe("deleting");
    expect(hasChild()).toBe(true);
  });

  test("keeps the bouncer's refusal when a later command fails", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INTERNAL_ERROR",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Not allowed",
    });
    ircClient.triggerEvent("BOUNCER_FAIL", {
      serverId: PARENT,
      code: "INVALID_ATTRIBUTE",
      subcommand: "CHANGENETWORK",
      netid: "7",
      context: ["7", "host"],
      description: "Invalid host",
    });

    expect(target()).toMatchObject({
      status: "refused",
      refusal: "Not allowed",
    });
  });

  test("keeps the open chat when a network in the background is deleted", () => {
    seed(true);
    useStore.setState((state) => ({
      servers: [{ ...state.servers[0], id: "other" }, ...state.servers],
      ui: { ...state.ui, selectedServerId: PARENT, selectedChannelId: "chan" },
    }));
    useStore.getState().requestDeleteBouncerNetwork(PARENT, NETID);
    useStore.getState().confirmDisconnectNetwork(false);
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(hasChild()).toBe(false);
    expect(useStore.getState().ui).toMatchObject({
      selectedServerId: PARENT,
      selectedChannelId: "chan",
    });
  });

  test("moves to another server when the open network is deleted", () => {
    seed(true);
    useStore.setState((state) => ({
      ui: { ...state.ui, selectedServerId: CHILD, selectedChannelId: "chan" },
    }));
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(false);
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(useStore.getState().ui).toMatchObject({
      selectedServerId: PARENT,
      selectedChannelId: null,
    });
  });

  test("settles the history and drops the saved profile of a network that has no connection here", () => {
    seed(true);
    useStore.setState((state) => ({
      servers: state.servers.filter((s) => s.id !== CHILD),
    }));
    lsBacking.set("savedServers", JSON.stringify([SAVED_CHILD]));
    useStore.getState().requestDeleteBouncerNetwork(PARENT, NETID);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD, bouncerNetid: NETID }),
      true,
    );
    expect(JSON.parse(lsBacking.get("savedServers") ?? "[]")).toEqual([]);
    expect(target()).toBeNull();
  });

  test("closes while the bouncer has not answered and keeps the delete waiting", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    useStore.getState().cancelDisconnectNetwork();

    expect(target()).toBeNull();
    expect(Object.keys(useStore.getState().pendingNetworkDeletes)).toEqual([
      `${PARENT}:${NETID}`,
    ]);
    expect(hasChild()).toBe(true);
  });

  test("asks before deleting a network that has no connection here", () => {
    seed(true);
    useStore.getState().deleteServer(CHILD);
    useStore.getState().requestDeleteBouncerNetwork(PARENT, NETID);

    expect(target()).toEqual({
      bouncerServerId: PARENT,
      netid: NETID,
      childServerId: CHILD,
      identity: "Net\nirc.example\n",
    });
  });
});
