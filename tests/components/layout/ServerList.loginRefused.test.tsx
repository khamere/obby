import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ServerList } from "../../../src/components/layout/ServerList";
import useStore from "../../../src/store";
import type { Server } from "../../../src/types";

// Loading the modules under test takes seconds on a busy machine, longer
// than the default timeout allows.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn(() => "linux"),
}));

const offline = (server: Partial<Server>): Server => ({
  id: "direct",
  name: "Direct",
  host: "irc.example.com",
  port: 443,
  channels: [],
  privateChats: [],
  users: [],
  isConnected: false,
  connectionState: "disconnected",
  ...server,
});

const refusedMarks = () =>
  screen.queryAllByRole("img", { name: /refused your login/i });

describe("server list marks a refused login", () => {
  beforeEach(() => {
    useStore.setState({ servers: [], bouncers: {} });
  });

  test("on a server and on a bouncer, without selecting either", () => {
    useStore.setState({
      servers: [
        offline({ loginRefused: true }),
        offline({
          id: "bouncer",
          name: "Bouncer",
          isBouncerControl: true,
          loginRefused: true,
        }),
      ],
    });
    render(<ServerList expanded={false} onToggleExpanded={() => {}} />);
    expect(refusedMarks()).toHaveLength(2);
  });

  test("leaves a server that only lost its link unmarked", () => {
    useStore.setState({
      servers: [
        offline({}),
        offline({ id: "bouncer", name: "Bouncer", isBouncerControl: true }),
      ],
    });
    render(<ServerList expanded={false} onToggleExpanded={() => {}} />);
    expect(refusedMarks()).toHaveLength(0);
  });
});
