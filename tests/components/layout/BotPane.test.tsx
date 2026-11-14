import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BotPane from "../../../src/components/layout/BotPane";
import ircClient from "../../../src/lib/ircClient";
import useStore from "../../../src/store";
import type { Channel, PushBotInfo } from "../../../src/types";

const channel: Channel = {
  id: "announcements",
  name: "#announcements",
  serverId: "server1",
  isPrivate: false,
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [
    {
      id: "bot",
      username: "ReleaseBot",
      isBot: true,
      isOnline: true,
      realname: "Upload announcement bot",
    },
  ],
};

const greeter: PushBotInfo = {
  bot_id: "bot1",
  nick: "Greeter",
  realname: "Says hello",
  scope: "server",
  transport: "gateway",
  status: "active",
  online: true,
  from_config: false,
  channels: [],
  commands: [{ name: "hello", description: "Say hello" }],
};

describe("BotPane", () => {
  beforeEach(() => {
    useStore.setState({
      servers: [
        {
          id: "server1",
          name: "Test Server",
          host: "irc.test.com",
          port: 6667,
          channels: [],
          privateChats: [],
          isConnected: true,
          users: [],
          connectionState: "connected",
          bots: { greeter },
        },
      ],
      currentUser: null,
      ui: {
        ...useStore.getState().ui,
        sidePane: { kind: "bot", serverId: "server1", botNick: "greeter" },
        pendingBotCommandPick: null,
        pendingComposerCommand: null,
      },
    });
  });

  it("requests the command pick for the bot and closes the pane", () => {
    render(<BotPane target={{ serverId: "server1", botNick: "greeter" }} />);

    fireEvent.click(screen.getByText("/hello"));

    expect(useStore.getState().ui.pendingBotCommandPick).toEqual({
      serverId: "server1",
      botNick: "Greeter",
      command: greeter.commands[0],
    });
    expect(useStore.getState().ui.sidePane).toBeNull();
  });

  it("renders IRC colors in the real name", () => {
    useStore.setState({
      servers: useStore.getState().servers.map((server) => ({
        ...server,
        bots: { greeter: { ...greeter, realname: "\x0304Says\x03 hello" } },
      })),
    });

    render(<BotPane target={{ serverId: "server1", botNick: "greeter" }} />);

    const says = screen.getByText("Says");
    expect(says.parentElement?.textContent).toBe("Says hello");
    expect(says.style.color).not.toBe("");
  });

  it("lists a regular IRC bot without directory or command-list support", () => {
    useStore.setState({
      servers: useStore.getState().servers.map((server) => ({
        ...server,
        bots: undefined,
        channels: [channel],
      })),
    });
    render(<BotPane target={{ serverId: "server1" }} />);
    fireEvent.click(screen.getByRole("button", { name: "ReleaseBot" }));
    expect(useStore.getState().ui.sidePane).toMatchObject({
      kind: "bot",
      serverId: "server1",
      botNick: "ReleaseBot",
    });
  });

  it("shows regular bot details without PUSHBOT controls, even for an operator", () => {
    const oper = { id: "me", username: "Admin", isOnline: true, isIrcOp: true };
    useStore.setState({
      currentUser: oper,
      servers: useStore.getState().servers.map((server) => ({
        ...server,
        bots: undefined,
        channels: [channel],
        users: [oper],
      })),
    });
    const send = vi.spyOn(ircClient, "sendRaw");
    render(<BotPane target={{ serverId: "server1", botNick: "releasebot" }} />);
    expect(screen.getByText("Upload announcement bot")).toBeInTheDocument();
    expect(screen.getByText("#announcements")).toBeInTheDocument();
    expect(screen.queryByText("Transport")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator actions")).not.toBeInTheDocument();
    expect(screen.queryByText("Suspend")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it("updates when WHO discovers a bot, and removes departed or disconnected bots", () => {
    useStore.setState({
      servers: useStore.getState().servers.map((server) => ({
        ...server,
        bots: undefined,
        channels: [{ ...channel, users: [] }],
      })),
    });
    render(<BotPane target={{ serverId: "server1" }} />);
    expect(screen.queryByText("ReleaseBot")).not.toBeInTheDocument();
    act(() =>
      useStore.setState({
        servers: useStore
          .getState()
          .servers.map((server) => ({ ...server, channels: [channel] })),
      }),
    );
    expect(screen.getByText("ReleaseBot")).toBeInTheDocument();
    act(() =>
      useStore.setState({
        servers: useStore
          .getState()
          .servers.map((server) => ({ ...server, channels: [] })),
      }),
    );
    expect(screen.queryByText("ReleaseBot")).not.toBeInTheDocument();
    act(() =>
      useStore.setState({
        servers: useStore.getState().servers.map((server) => ({
          ...server,
          isConnected: false,
          channels: [channel],
        })),
      }),
    );
    expect(screen.queryByText("ReleaseBot")).not.toBeInTheDocument();
  });
});
