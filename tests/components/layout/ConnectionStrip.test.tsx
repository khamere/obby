import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStrip } from "../../../src/components/layout/ConnectionStrip";
import type { Server } from "../../../src/types";

const reconnectServer = vi.fn();
const editConnection = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => ({ isTouch: false }));

vi.mock("../../../src/hooks/useIsTouchInput", () => ({
  useIsTouchInput: () => input.isTouch,
}));

vi.mock("../../../src/store", () => {
  const mockStore = vi.fn((selector: (state: unknown) => unknown) =>
    selector({ reconnectServer }),
  );
  return { default: mockStore };
});

vi.mock("../../../src/components/layout/NetworkMenu", () => ({
  editConnection,
}));

function renderSettled(server: Server) {
  const result = render(<ConnectionStrip server={server} />);
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  return result;
}

const baseServer: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6667,
  channels: [],
  privateChats: [],
  isConnected: true,
  users: [],
  connectionState: "connected",
};

describe("ConnectionStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    input.isTouch = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays quiet while a fresh connection is still coming up", () => {
    const { container } = render(
      <ConnectionStrip
        server={{ ...baseServer, connectionState: "disconnected" }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a healthy connected server", () => {
    const { container } = render(<ConnectionStrip server={baseServer} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("waits again when the connection drops a second time", () => {
    const lost = { ...baseServer, connectionState: "disconnected" as const };
    const { container, rerender } = render(<ConnectionStrip server={lost} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender(<ConnectionStrip server={baseServer} />);
    rerender(<ConnectionStrip server={lost} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a reconnect button when disconnected and calls reconnectServer with the server id", () => {
    renderSettled({ ...baseServer, connectionState: "disconnected" });
    const button = screen.getByRole("button", { name: /reconnect/i });
    fireEvent.click(button);
    expect(reconnectServer).toHaveBeenCalledWith("server1");
  });

  it("only shows the edit button while reconnecting", () => {
    renderSettled({ ...baseServer, connectionState: "reconnecting" });
    expect(
      screen.queryByRole("button", { name: /reconnect/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("opens the login form from 'Log in again' when SASL failed", () => {
    renderSettled({ ...baseServer, isRegistered: true, saslFailed: true });
    fireEvent.click(screen.getByRole("button", { name: /log in again/i }));
    expect(editConnection).toHaveBeenCalledWith("server1", "auth");
  });

  it("names a refused login at once and offers the login form and a retry", () => {
    render(
      <ConnectionStrip
        server={{
          ...baseServer,
          isConnected: false,
          connectionState: "disconnected",
          loginRefused: true,
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/refused your login/i);
    fireEvent.click(screen.getByRole("button", { name: /log in again/i }));
    expect(editConnection).toHaveBeenCalledWith("server1", "auth");
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(reconnectServer).toHaveBeenCalledWith("server1");
  });

  it("sends a refused bouncer network to the bouncer's login form", () => {
    renderSettled({
      ...baseServer,
      bouncerServerId: "bouncer",
      isConnected: false,
      connectionState: "disconnected",
      loginRefused: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /log in again/i }));
    expect(editConnection).toHaveBeenCalledWith("bouncer", "auth");
  });

  it("logs a bouncer network in again on its own connection", () => {
    renderSettled({
      ...baseServer,
      bouncerServerId: "bouncer",
      isRegistered: true,
      saslFailed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /log in again/i }));
    expect(reconnectServer).toHaveBeenCalledWith("server1");
    expect(editConnection).not.toHaveBeenCalled();
  });

  it("gives every action a finger-sized target on touch input", () => {
    input.isTouch = true;
    renderSettled({
      ...baseServer,
      isConnected: false,
      connectionState: "disconnected",
      loginRefused: true,
    });
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveClass("h-11");
  });

  it("keeps the compact actions for a mouse", () => {
    renderSettled({
      ...baseServer,
      isConnected: false,
      connectionState: "disconnected",
      loginRefused: true,
    });
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveClass("h-7");
  });
});
