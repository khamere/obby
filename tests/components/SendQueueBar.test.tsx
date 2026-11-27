import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendQueueBar } from "../../src/components/ui/SendQueueBar";
import ircClient from "../../src/lib/ircClient";

describe("the row for messages that wait to be sent", () => {
  let waiting = { waiting: 0, total: 0 };
  let read: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    waiting = { waiting: 0, total: 0 };
    read = vi
      .spyOn(ircClient, "waitingLines")
      .mockImplementation(() => waiting);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The row reads the queue on the frame after the change.
  const queueChanged = (serverId: string) =>
    act(() => {
      ircClient.triggerEvent("sendQueue", { serverId });
      vi.advanceTimersByTime(50);
    });

  it("shows nothing while no line waits", () => {
    const { container } = render(<SendQueueBar serverId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing without a server", () => {
    waiting = { waiting: 3, total: 3 };
    const { container } = render(<SendQueueBar serverId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows how many lines are left and how far the send is", () => {
    waiting = { waiting: 37, total: 42 };
    const { container } = render(<SendQueueBar serverId="s1" />);
    expect(screen.getByText("Sending")).toBeInTheDocument();
    expect(screen.getByText("37 lines")).toBeInTheDocument();
    const filled = container.querySelector<HTMLElement>(".bg-discord-primary");
    expect(Number.parseFloat(filled?.style.width ?? "")).toBeCloseTo(
      (5 / 42) * 100,
    );
  });

  it("counts a single line in the singular", () => {
    waiting = { waiting: 1, total: 42 };
    render(<SendQueueBar serverId="s1" />);
    expect(screen.getByText("1 line")).toBeInTheDocument();
  });

  it("follows the queue of its own server and ignores the others", () => {
    waiting = { waiting: 3, total: 3 };
    render(<SendQueueBar serverId="s1" />);
    const reads = read.mock.calls.length;

    queueChanged("s2");
    expect(read.mock.calls.length).toBe(reads);

    waiting = { waiting: 2, total: 3 };
    queueChanged("s1");
    expect(screen.getByText("2 lines")).toBeInTheDocument();

    waiting = { waiting: 0, total: 0 };
    queueChanged("s1");
    expect(screen.queryByText("Sending")).not.toBeInTheDocument();
  });

  it("reads the queue once for a burst of changes", () => {
    waiting = { waiting: 3, total: 3 };
    render(<SendQueueBar serverId="s1" />);
    const reads = read.mock.calls.length;
    act(() => {
      for (let change = 0; change < 95; change++)
        ircClient.triggerEvent("sendQueue", { serverId: "s1" });
      vi.advanceTimersByTime(50);
    });
    expect(read.mock.calls.length).toBe(reads + 1);
  });

  it("drops the waiting lines of its server on Cancel", () => {
    waiting = { waiting: 3, total: 3 };
    const cancel = vi
      .spyOn(ircClient, "cancelWaitingLines")
      .mockImplementation(() => {});
    render(<SendQueueBar serverId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("stops listening when it leaves the page", () => {
    const deleteHook = vi.spyOn(ircClient, "deleteHook");
    const on = vi.spyOn(ircClient, "on");
    const { unmount } = render(<SendQueueBar serverId="s1" />);
    const listener = on.mock.calls.find(
      ([event]) => event === "sendQueue",
    )?.[1];
    expect(listener).toBeDefined();
    unmount();
    expect(deleteHook).toHaveBeenCalledWith("sendQueue", listener);
  });
});
