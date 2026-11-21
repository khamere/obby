import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BouncerNetworkDisconnectConfirmModal } from "../../src/components/ui/BouncerNetworkDisconnectConfirmModal";

const confirmDisconnectNetwork = vi.fn();
const cancelDisconnectNetwork = vi.fn();

const state = {
  servers: [
    { id: "bnc", name: "bouncer", isConnected: true },
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
      status: undefined as "deleting" | "refused" | undefined,
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

describe("BouncerNetworkDisconnectConfirmModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.servers[0].isConnected = true;
    state.bouncers.bnc.lastError = undefined;
    state.ui.disconnectNetworkConfirmTarget.status = undefined;
  });

  it("names the action a delete and says what goes with the network", () => {
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByText("Delete network?")).toBeInTheDocument();
    expect(
      screen.getByText(/channel list and the chat history/),
    ).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("shows the bouncer's refusal and offers the delete again", () => {
    state.ui.disconnectNetworkConfirmTarget.status = "refused";
    state.bouncers.bnc.lastError = { description: "Invalid network ID" };
    render(<BouncerNetworkDisconnectConfirmModal />);

    expect(screen.getByTestId("bouncer-delete-refused")).toHaveTextContent(
      "Invalid network ID",
    );
    expect(
      screen.getByRole("button", { name: "Delete network" }),
    ).toBeEnabled();
  });
});
