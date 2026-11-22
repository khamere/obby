import { fireEvent, render, screen } from "@testing-library/react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BouncerNetworkDisconnectConfirmModal } from "../../src/components/ui/BouncerNetworkDisconnectConfirmModal";

const confirmDisconnectNetwork = vi.fn();
const cancelDisconnectNetwork = vi.fn();

const state = {
  servers: [
    { id: "bnc", name: "bouncer", isConnected: true, isRegistered: true },
    { id: "child", name: "TestNet", isConnected: true },
  ],
  bouncers: {
    bnc: {
      networks: { "7": { netid: "7", attributes: { name: "TestNet" } } },
      lastError: undefined as { description: string } | undefined,
    },
  },
  ui: {
    disconnectNetworkConfirmTarget: {
      bouncerServerId: "bnc",
      netid: "7",
      childServerId: "child",
      status: undefined as "deleting" | "unanswered" | "refused" | undefined,
      shouldDeleteHistory: undefined as boolean | undefined,
      refusal: undefined as string | undefined,
      isAwaitingList: undefined as boolean | undefined,
    },
  },
  confirmDisconnectNetwork,
  cancelDisconnectNetwork,
};

vi.mock("../../src/store", () => ({
  default: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock("../../src/store/handlers/history", () => ({
  hasSavedHistory: vi.fn(async () => false),
}));

import { hasSavedHistory } from "../../src/store/handlers/history";

describe("BouncerNetworkDisconnectConfirmModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (hasSavedHistory as Mock).mockResolvedValue(false);
    state.servers[0].isConnected = true;
    state.servers[0].isRegistered = true;
    state.bouncers.bnc.lastError = undefined;
    state.ui.disconnectNetworkConfirmTarget.status = undefined;
    state.ui.disconnectNetworkConfirmTarget.shouldDeleteHistory = undefined;
    state.ui.disconnectNetworkConfirmTarget.refusal = undefined;
    state.ui.disconnectNetworkConfirmTarget.isAwaitingList = undefined;
  });

  it("holds the second delete back until the network list is in", () => {
    state.ui.disconnectNetworkConfirmTarget.status = "unanswered";
    state.ui.disconnectNetworkConfirmTarget.isAwaitingList = true;
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(
      screen.getByRole("button", { name: "Delete network" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("promises the saved history back only for a network with the same ID", async () => {
    (hasSavedHistory as Mock).mockResolvedValue(true);
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(
      await screen.findByText(/only if the bouncer gives it the same ID/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Add this network again to get/),
    ).not.toBeInTheDocument();
  });

  it("names the action a delete and says what goes with the network", () => {
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByText("Delete network?")).toBeInTheDocument();
    expect(
      screen.getByText(/drops this network and its channel list/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete network" }));
    expect(confirmDisconnectNetwork).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("leaves open whether the bouncer deletes the history it stored", () => {
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(
      screen.getByText(/may keep the chat history it stored/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/together with/)).not.toBeInTheDocument();
  });

  it("refuses the delete until the bouncer connection has logged in", () => {
    state.servers[0].isRegistered = false;
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByTestId("bouncer-delete-offline")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete network" }),
    ).toBeDisabled();
  });

  it("locks the saved-history choice a pending delete was sent with", async () => {
    (hasSavedHistory as Mock).mockResolvedValue(true);
    state.ui.disconnectNetworkConfirmTarget.status = "deleting";
    state.ui.disconnectNetworkConfirmTarget.shouldDeleteHistory = true;
    render(<BouncerNetworkDisconnectConfirmModal />);

    const choice = await screen.findByRole("checkbox");
    expect(choice).toBeChecked();
    expect(choice).toBeDisabled();
  });

  it("lets go of a delete the bouncer has not answered and offers it again", async () => {
    (hasSavedHistory as Mock).mockResolvedValue(true);
    state.ui.disconnectNetworkConfirmTarget.status = "unanswered";
    state.ui.disconnectNetworkConfirmTarget.shouldDeleteHistory = true;
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByTestId("bouncer-delete-unanswered")).toHaveTextContent(
      "the saved chat history stays",
    );
    const choice = await screen.findByRole("checkbox");
    expect(choice).toBeEnabled();
    expect(choice).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelDisconnectNetwork).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete network" }));
    expect(confirmDisconnectNetwork).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("refuses the delete while the bouncer is not connected", () => {
    state.servers[0].isConnected = false;
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByTestId("bouncer-delete-offline")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete network" }),
    ).toBeDisabled();
  });

  it("waits for the bouncer's answer", () => {
    state.ui.disconnectNetworkConfirmTarget.status = "deleting";
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelDisconnectNetwork).toHaveBeenCalledOnce();
  });

  it("shows the bouncer's refusal and offers the delete again", () => {
    state.ui.disconnectNetworkConfirmTarget.status = "refused";
    state.ui.disconnectNetworkConfirmTarget.refusal = "Invalid network ID";
    state.bouncers.bnc.lastError = { description: "Invalid host" };
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByTestId("bouncer-delete-refused")).toHaveTextContent(
      "Invalid network ID",
    );
    expect(
      screen.getByRole("button", { name: "Delete network" }),
    ).toBeEnabled();
  });
});
