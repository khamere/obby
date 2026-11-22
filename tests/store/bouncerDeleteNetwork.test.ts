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
          [NETID]: { netid: NETID, attributes: { name: "Net" } },
        },
      },
    },
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
function listNetworks(netids: string[]) {
  ircClient.triggerEvent("BATCH_START", {
    serverId: PARENT,
    batchId: "list",
    type: "soju.im/bouncer-networks",
    parameters: [],
    sender: "bouncer.example",
  });
  for (const netid of netids)
    ircClient.triggerEvent("BOUNCER_NETWORK", {
      serverId: PARENT,
      netid,
      deleted: false,
      attributes: { name: "Net" },
      batchTag: "list",
    });
  ircClient.triggerEvent("BATCH_END", { serverId: PARENT, batchId: "list" });
}

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
    ircClient.triggerEvent("BOUNCER_DELNETWORK_OK", {
      serverId: PARENT,
      netid: NETID,
    });

    expect(hasChild()).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );
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
      code: "INVALID_NETID",
      subcommand: "DELNETWORK",
      netid: NETID,
      context: [NETID],
      description: "Invalid network ID",
    });

    expect(hasChild()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(target()?.status).toBe("refused");
    expect(useStore.getState().bouncers[PARENT].lastError?.description).toBe(
      "Invalid network ID",
    );
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
    ircClient.triggerEvent("connectionStateChange", {
      serverId: PARENT,
      connectionState: "reconnecting",
    });

    expect(hasChild()).toBe(true);
    expect(target()).toMatchObject({ netid: NETID, status: "unanswered" });
    useStore.getState().cancelDisconnectNetwork();
    expect(target()).toBeNull();
  });

  test("finishes a delete whose answer was lost once the network list lacks it", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    ircClient.triggerEvent("connectionStateChange", {
      serverId: PARENT,
      connectionState: "reconnecting",
    });
    listNetworks(["7"]);

    expect(hasChild()).toBe(false);
    expect(useStore.getState().bouncers[PARENT].networks[NETID]).toBe(
      undefined,
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: CHILD }),
      true,
    );
    expect(target()).toBeNull();
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
  });

  test("stops waiting for an answer that never comes and asks for the list", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    vi.advanceTimersByTime(NETWORK_DELETE_WAIT_MS - 1);
    expect(target()?.status).toBe("deleting");
    vi.advanceTimersByTime(1);

    expect(target()?.status).toBe("unanswered");
    expect(listRequest).toHaveBeenCalledExactlyOnceWith(PARENT);
    expect(hasChild()).toBe(true);
    useStore.getState().cancelDisconnectNetwork();
    expect(target()).toBeNull();
  });

  test("leaves an answered delete alone when the wait runs out", () => {
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
  });

  test("keeps the bouncer's refusal when a later command fails", () => {
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
      refusal: "Invalid network ID",
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

  test("stays open while the bouncer has not answered", () => {
    seed(true);
    useStore.getState().requestDeleteServer(CHILD);
    useStore.getState().confirmDisconnectNetwork(true);
    useStore.getState().cancelDisconnectNetwork();
    useStore.getState().confirmDisconnectNetwork(true);

    expect(target()?.status).toBe("deleting");
    expect(delNetwork).toHaveBeenCalledOnce();
  });

  test("asks before deleting a network that has no connection here", () => {
    seed(true);
    useStore.getState().deleteServer(CHILD);
    useStore.getState().requestDeleteBouncerNetwork(PARENT, NETID);

    expect(target()).toEqual({
      bouncerServerId: PARENT,
      netid: NETID,
      childServerId: CHILD,
    });
  });
});
