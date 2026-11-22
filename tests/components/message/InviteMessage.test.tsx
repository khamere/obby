import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { InviteMessage } from "../../../src/components/message/InviteMessage";
import type { AppState } from "../../../src/store";
import useStore from "../../../src/store";
import type { Channel, Message } from "../../../src/types";

const invite = {
  id: "m1",
  type: "invite",
  content: "",
  timestamp: new Date(0),
  userId: "host",
  channelId: "c0",
  serverId: "server1",
  inviteChannel: "#Lounge",
  inviteTarget: "me",
  reactions: [],
  replyMessage: null,
  mentioned: [],
} as unknown as Message;

function showChannel(channel: Partial<Channel>) {
  useStore.setState({
    servers: [
      {
        id: "server1",
        name: "Test",
        host: "irc.test",
        port: 6697,
        channels: [{ id: "c1", users: [], messages: [], ...channel }],
        privateChats: [],
        isConnected: true,
        users: [],
      },
    ],
  } as unknown as Partial<AppState>);
}

describe("an invite to a channel we already show", () => {
  beforeEach(() => showChannel({ name: "#lounge" }));

  test("offers no join while we are in the channel", () => {
    render(<InviteMessage message={invite} onUsernameContextMenu={() => {}} />);
    expect(screen.getByText("Already in #Lounge")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("offers the join once we are out of the channel", () => {
    showChannel({ name: "#Lounge", leftReason: "kicked" });
    render(<InviteMessage message={invite} onUsernameContextMenu={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Join #Lounge" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Already in #Lounge")).toBeNull();
  });
});
