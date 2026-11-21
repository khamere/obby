import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore, { type AppState } from "../../src/store";
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

const target = () => useStore.getState().ui.disconnectNetworkConfirmTarget;
const hasChild = () => useStore.getState().servers.some((s) => s.id === CHILD);

describe("deleting a bouncer network", () => {
  let delNetwork: ReturnType<typeof vi.spyOn>;
  let settle: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(ircClient, "removeServer").mockImplementation(() => {});
    delNetwork = vi
      .spyOn(ircClient, "bouncerDelNetwork")
      .mockImplementation(() => {});
    settle = vi.spyOn(history, "settleSavedHistory").mockResolvedValue();
  });

  afterEach(() => {
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
    expect(target()).toMatchObject({ netid: NETID });
    expect(target()?.status).toBeUndefined();
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
