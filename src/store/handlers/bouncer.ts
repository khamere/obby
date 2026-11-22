import type { StoreApi } from "zustand";
import ircClient from "../../lib/ircClient";
import type { BouncerState } from "../../types";
import { generateDeterministicId } from "../helpers";
import type { AppState } from "../index";
import * as storage from "../localStorage";
import { settleSavedHistory } from "./history";

// Module-scope so a single childId only ever dispatches one bind across
// the burst of BOUNCER_NETWORK events that arrive during the initial
// LISTNETWORKS dump.
const autoBindAttempted = new Set<string>();

function autoBindConnectedNetworks(
  store: StoreApi<AppState>,
  bouncerServerId: string,
) {
  const state = store.getState();
  // Skip events that fired against a bouncer CHILD (which itself
  // negotiates the same cap); otherwise we'd recursively bind
  // "grandchildren" off each child.
  const sourceServer = state.servers.find((s) => s.id === bouncerServerId);
  if (sourceServer?.bouncerNetid) return;
  const bouncer = state.bouncers[bouncerServerId];
  if (!bouncer) return;
  for (const net of Object.values(bouncer.networks)) {
    if (net.attributes.state !== "connected") continue;
    const childId = generateDeterministicId(bouncerServerId, net.netid);
    if (autoBindAttempted.has(childId)) continue;
    if (state.servers.some((s) => s.id === childId)) {
      autoBindAttempted.add(childId);
      continue;
    }
    autoBindAttempted.add(childId);
    void state.bouncerConnectNetwork(bouncerServerId, net.netid);
  }
}

// Helper that lazily creates a BouncerState entry for a serverId.
// We can't always know in advance which servers will turn out to be
// bouncers, so we treat the first BOUNCER-* event from a serverId as
// implicit setup.
function ensureBouncer(
  state: AppState,
  serverId: string,
  patch: Partial<BouncerState> = {},
): AppState["bouncers"] {
  const existing = state.bouncers[serverId];
  const base: BouncerState = existing ?? {
    serverId,
    supported: false,
    notifyEnabled: false,
    networks: {},
    listed: false,
  };
  return { ...state.bouncers, [serverId]: { ...base, ...patch } };
}

type NetworkDeleteTarget = NonNullable<
  AppState["ui"]["disconnectNetworkConfirmTarget"]
>;

function setNetworkDeleteTarget(
  store: StoreApi<AppState>,
  target: NetworkDeleteTarget | null,
) {
  store.setState((state) => ({
    ui: { ...state.ui, disconnectNetworkConfirmTarget: target },
  }));
}

// A network that was offline at startup has a saved profile and no connection
// here, so we look in both places.
function findChild(state: AppState, childId: string) {
  return (
    state.servers.find((s) => s.id === childId) ??
    storage.servers.load().find((s) => s.id === childId)
  );
}

// A network the bouncer no longer has takes its row, its connection and its
// saved profile with it, and our own delete of it also settles the saved
// history the way its dialog chose.
function dropNetwork(
  store: StoreApi<AppState>,
  serverId: string,
  netid: string,
) {
  const childId = generateDeterministicId(serverId, netid);
  autoBindAttempted.delete(childId);
  const state = store.getState();
  const target = state.ui.disconnectNetworkConfirmTarget;
  if (target?.bouncerServerId === serverId && target.netid === netid) {
    const child = findChild(state, target.childServerId);
    const isOurDelete =
      target.status === "deleting" || target.status === "unanswered";
    if (child && isOurDelete)
      void settleSavedHistory(child, target.shouldDeleteHistory === true);
    setNetworkDeleteTarget(store, null);
  }
  const bouncer = state.bouncers[serverId];
  if (bouncer?.networks[netid]) {
    const { [netid]: _, ...networks } = bouncer.networks;
    store.setState((current) => ({
      bouncers: { ...current.bouncers, [serverId]: { ...bouncer, networks } },
    }));
  }
  if (findChild(state, childId)) state.deleteServer(childId);
}

export function registerBouncerHandlers(store: StoreApi<AppState>): void {
  // BOUNCER NETWORK <netid> <attrs|"*">. Either a snapshot (full attrs,
  // e.g. inside a LISTNETWORKS batch or an initial -notify dump) or an
  // incremental update (only changed attrs, in notify mode).
  ircClient.on(
    "BOUNCER_NETWORK",
    ({ serverId, netid, deleted, attributes, batchTag }) => {
      store.setState((state) => {
        const existing = state.bouncers[serverId];
        const base: BouncerState = existing ?? {
          serverId,
          supported: false,
          notifyEnabled: false,
          networks: {},
          listed: false,
        };
        if (deleted) {
          const { [netid]: _, ...rest } = base.networks;
          return {
            bouncers: {
              ...state.bouncers,
              [serverId]: { ...base, networks: rest },
            },
          };
        }
        // Spec: in notify mode, an attr with an empty value is a deletion
        // for that attr. Merge incoming on top of existing and strip those.
        const prev = base.networks[netid]?.attributes ?? {};
        const merged: Record<string, string> = { ...prev };
        for (const [k, v] of Object.entries(attributes)) {
          if (v === "") delete merged[k];
          else merged[k] = v;
        }
        return {
          bouncers: {
            ...state.bouncers,
            [serverId]: {
              ...base,
              networks: {
                ...base.networks,
                [netid]: { netid, attributes: merged },
              },
            },
          },
        };
      });
      // Only the control connection owns names for its bound children.
      const state = store.getState();
      if (
        !deleted &&
        attributes.name &&
        !state.servers.find((s) => s.id === serverId)?.bouncerNetid
      ) {
        const childId = generateDeterministicId(serverId, netid);
        if (
          state.servers.some(
            (s) => s.id === childId && s.name !== attributes.name,
          )
        ) {
          store.setState((current) => ({
            servers: current.servers.map((s) =>
              s.id === childId ? { ...s, name: attributes.name } : s,
            ),
          }));
        }
        const saved = storage.servers.load();
        if (saved.some((s) => s.id === childId && s.name !== attributes.name)) {
          storage.servers.save(
            saved.map((s) =>
              s.id === childId ? { ...s, name: attributes.name } : s,
            ),
          );
        }
      }
      if (attributes.state === "connected" || (!deleted && attributes.state)) {
        autoBindConnectedNetworks(store, serverId);
      }
      // A network the bouncer lost upstream (state=disconnected) keeps its
      // child here: soju holds our bound connection and rejoins everything
      // when the network is back, and dropping the child would lose its
      // buffers and throw the user onto the bouncer's network list, in the
      // middle of typing. We only forget the auto-bind memory, so a bind is
      // tried again if the child is ever gone when it reconnects. A network
      // the bouncer deleted takes its child with it.
      if (attributes.state === "disconnected")
        autoBindAttempted.delete(generateDeterministicId(serverId, netid));
      if (deleted) dropNetwork(store, serverId, netid);
      else if (batchTag) snapshots.get(`${serverId}:${batchTag}`)?.add(netid);
    },
  );

  // The netids each open soju.im/bouncer-networks batch has listed so far,
  // keyed by `${serverId}:${batchId}`.
  const snapshots = new Map<string, Set<string>>();

  // A bouncer without the notify capability sends no BOUNCER NETWORK line for
  // a delete, so its acknowledgement is where we drop the network.
  ircClient.on("BOUNCER_DELNETWORK_OK", ({ serverId, netid }) => {
    dropNetwork(store, serverId, netid);
  });

  // A dropped control connection loses the answer to a pending delete, so we
  // stop waiting and keep the dialog's choice for the network list the
  // bouncer sends once we are back.
  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState === "connected") return;
    const target = store.getState().ui.disconnectNetworkConfirmTarget;
    if (target?.bouncerServerId !== serverId || target.status !== "deleting")
      return;
    setNetworkDeleteTarget(store, { ...target, status: "unanswered" });
  });

  // Errors from any subcommand. Stash on the bouncer state so the UI
  // can pick them up reactively (toast / inline form error).
  ircClient.on(
    "BOUNCER_FAIL",
    ({ serverId, code, subcommand, attribute, netid, description }) => {
      store.setState((state) => ({
        bouncers: ensureBouncer(state, serverId, {
          lastError: { code, subcommand, attribute, netid, description },
        }),
      }));
      const target = store.getState().ui.disconnectNetworkConfirmTarget;
      if (
        subcommand.toUpperCase() === "DELNETWORK" &&
        target?.bouncerServerId === serverId &&
        target.status === "deleting" &&
        (netid === undefined || netid === target.netid)
      )
        setNetworkDeleteTarget(store, {
          ...target,
          status: "refused",
          refusal: description,
        });
    },
  );

  // CAP ACK plumbing: CAP_ACKNOWLEDGED fires once per acked cap with the
  // cap name in `key`. Mark supported when bouncer-networks is acked, and
  // notifyEnabled when the -notify variant is acked (the latter lets us
  // skip an explicit LISTNETWORKS since the server pushes the initial
  // dump unprompted).
  ircClient.on("CAP_ACKNOWLEDGED", ({ serverId, key }) => {
    const supported = key === "soju.im/bouncer-networks";
    const notify = key === "soju.im/bouncer-networks-notify";
    if (!supported && !notify) return;
    store.setState((state) => ({
      bouncers: ensureBouncer(state, serverId, {
        supported: supported || state.bouncers[serverId]?.supported || false,
        notifyEnabled:
          notify || state.bouncers[serverId]?.notifyEnabled || false,
      }),
      servers:
        supported && !state.servers.find((s) => s.id === serverId)?.bouncerNetid
          ? state.servers.map((s) =>
              s.id === serverId ? { ...s, isBouncerControl: true } : s,
            )
          : state.servers,
    }));
  });

  // ISUPPORT BOUNCER_NETID tells us this connection is currently bound
  // to a specific upstream network. Empty value (or missing) means it's
  // a control connection.
  ircClient.on("ISUPPORT", ({ serverId, key, value }) => {
    if (key !== "BOUNCER_NETID") return;
    store.setState((state) => ({
      bouncers: ensureBouncer(state, serverId, {
        boundNetid: value || undefined,
      }),
    }));
  });

  // BATCH_END for a soju.im/bouncer-networks batch finalises the
  // "listed" flag so the UI can swap from a skeleton to the list. We
  // listen on BATCH_START to know the type and stash it; on BATCH_END
  // we look it up.
  // Batch reference tags are only unique per connection, so key by
  // serverId too — otherwise a same-tagged batch on another connection
  // (a bound child, a direct server) would flip the wrong bouncer's
  // "listed" flag and orphan the real LISTNETWORKS batch.
  ircClient.on("BATCH_START", ({ serverId, batchId, type }) => {
    if (type === "soju.im/bouncer-networks")
      snapshots.set(`${serverId}:${batchId}`, new Set());
  });
  ircClient.on("BATCH_END", ({ serverId, batchId }) => {
    const batchKey = `${serverId}:${batchId}`;
    const listedNetids = snapshots.get(batchKey);
    if (!listedNetids) return;
    snapshots.delete(batchKey);
    // The batch is the bouncer's whole network list, so a network we still
    // hold that is missing from it was deleted while we were not listening.
    const held = store.getState().bouncers[serverId]?.networks ?? {};
    for (const netid of Object.keys(held))
      if (!listedNetids.has(netid)) dropNetwork(store, serverId, netid);
    store.setState((state) => ({
      bouncers: ensureBouncer(state, serverId, { listed: true }),
    }));
    autoBindConnectedNetworks(store, serverId);
  });
}
