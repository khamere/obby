import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppLayout } from "../../../src/components/layout/AppLayout";
import useStore from "../../../src/store";
import type { Server } from "../../../src/types";

const serverWithMentions: Server = {
  id: "server1",
  name: "Test Server",
  host: "irc.test.com",
  port: 6697,
  channels: [
    {
      id: "channel1",
      name: "#general",
      topic: "",
      users: [],
      unreadCount: 2,
      mentionCount: 2,
      isMentioned: true,
      messages: [],
      isPrivate: false,
      serverId: "server1",
      metadata: {},
    },
  ],
  privateChats: [],
  users: [],
  isConnected: true,
  connectionState: "connected",
};

describe("AppLayout - Unread Title", () => {
  afterEach(() => {
    useStore.setState({ servers: [] });
  });

  it("follows the store's unread mentions in the document title", () => {
    document.title = "Loading";
    useStore.setState({ servers: [] });

    const { unmount } = render(<AppLayout />);
    expect(document.title).toBe("Obby");

    act(() => {
      useStore.setState({ servers: [serverWithMentions] });
    });
    expect(document.title).toBe("(2) Obby");

    unmount();
    expect(document.title).toBe("Obby");
  });
});
