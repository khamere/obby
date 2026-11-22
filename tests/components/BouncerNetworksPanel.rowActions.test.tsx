import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BouncerNetworksPanel } from "../../src/components/ui/BouncerNetworksPanel";

let isTouch = false;
vi.mock("../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => isTouch,
}));

const state = {
  servers: [{ id: "bnc", name: "bouncer", isConnected: true }],
  bouncers: {
    bnc: {
      serverId: "bnc",
      supported: true,
      notifyEnabled: true,
      listed: true,
      networks: { "7": { netid: "7", attributes: { name: "TestNet" } } },
    },
  },
  ui: { pendingBouncerEdit: null },
  bouncerAddNetwork: vi.fn(),
  bouncerChangeNetwork: vi.fn(),
  bouncerConnectNetwork: vi.fn(),
  bouncerListNetworks: vi.fn(),
  requestDeleteBouncerNetwork: vi.fn(),
  selectServer: vi.fn(),
  consumePendingBouncerEdit: vi.fn(),
};

vi.mock("../../src/store", () => ({
  default: (selector: (s: typeof state) => unknown) => selector(state),
}));

describe("BouncerNetworksPanel row actions", () => {
  beforeEach(() => {
    isTouch = false;
  });

  it("shows the delete at finger size on touch", () => {
    isTouch = true;
    render(<BouncerNetworksPanel bouncerServerId="bnc" />);

    const action = screen.getByTestId("bouncer-row-delete-7");
    expect(action).toHaveClass("w-11", "h-11");
    expect(action).not.toHaveClass("opacity-0");
  });

  it("reveals the delete on keyboard focus with a mouse", () => {
    render(<BouncerNetworksPanel bouncerServerId="bnc" />);

    expect(screen.getByTestId("bouncer-row-delete-7")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
    );
  });
});
