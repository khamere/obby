import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BouncerServerGroup } from "../../../src/components/layout/BouncerServerGroup";
import ircClient from "../../../src/lib/ircClient";
import useStore from "../../../src/store";
import { generateDeterministicId } from "../../../src/store/helpers";
import type { Server } from "../../../src/types";

const parent: Server = {
  id: "sidebar-parent",
  name: "soju",
  host: "soju.example",
  port: 443,
  channels: [],
  privateChats: [],
  users: [],
  isConnected: true,
};
const child: Server = {
  ...parent,
  id: generateDeterministicId(parent.id, "1"),
  name: "Old name",
  networkName: "Nether.RIP",
  bouncerServerId: parent.id,
  bouncerNetid: "1",
};
const other: Server = {
  ...child,
  id: "other",
  bouncerNetid: "2",
  name: "Zenith",
  networkName: "Aardvark",
};

function Group({ touch = false }: { touch?: boolean }) {
  const servers = useStore((s) => s.servers);
  return (
    <BouncerServerGroup
      control={parent}
      networks={servers.filter((s) => s.bouncerServerId === parent.id)}
      selectedServerId={child.id}
      shimmeringServers={new Set()}
      isTouchDevice={touch}
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onReconnect={vi.fn()}
    />
  );
}

describe("soju sidebar labels", () => {
  afterEach(() => {
    vi.useRealTimers();
    useStore.setState({ servers: [], bouncers: {} });
  });

  test("labels, initials, tooltips and sort order follow live soju renames", () => {
    useStore.setState({ servers: [parent, child, other], bouncers: {} });
    render(<Group />);
    act(() =>
      ircClient.triggerEvent("BOUNCER_NETWORK", {
        serverId: parent.id,
        netid: "1",
        deleted: false,
        attributes: { name: "upload.cx" },
      }),
    );
    const row = screen.getByRole("button", { name: "upload.cx" });
    expect(row).toHaveAttribute("title", "upload.cx");
    expect(within(row).getByText("U", { exact: true })).toBeInTheDocument();
    expect(row.querySelector(".obby-server-name")).toHaveTextContent(
      "upload.cx",
    );
    expect(within(row).getAllByText("upload.cx")).toHaveLength(2);
    expect(
      Array.from(document.querySelectorAll(".obby-server-row")).map((el) =>
        el.getAttribute("aria-label"),
      ),
    ).toEqual(["upload.cx", "Zenith", "Bouncer: soju"]);
    act(() =>
      ircClient.triggerEvent("BOUNCER_NETWORK", {
        serverId: parent.id,
        netid: "1",
        deleted: false,
        attributes: { name: "Zulu Tracker" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "upload.cx" }),
    ).not.toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll(".obby-server-row")).map((el) =>
        el.getAttribute("aria-label"),
      ),
    ).toEqual(["Zenith", "Zulu Tracker", "Bouncer: soju"]);
  });

  test("mobile long-press shows the saved soju name", () => {
    vi.useFakeTimers();
    useStore.setState({
      servers: [parent, { ...child, name: "upload.cx" }],
      bouncers: {},
    });
    render(<Group touch />);
    const row = screen.getByRole("button", { name: "upload.cx" });
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Edit Server")).toBeVisible();
    expect(screen.getAllByText("upload.cx").length).toBeGreaterThan(2);
  });
});
