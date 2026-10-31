import { beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { addLocalDmCopy } from "../../src/lib/localDmCopy";
import useStore from "../../src/store";

const key = "server1-pm1";
const user = { id: "u1", username: "tester" };

describe("addLocalDmCopy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ messages: {} });
  });

  it("adds nothing when the server echoes our DMs back", () => {
    vi.spyOn(ircClient, "hasCapability").mockImplementation(
      (_server, cap) => cap === "echo-message",
    );
    addLocalDmCopy("server1", "pm1", user, "https://host/img.png");
    expect(useStore.getState().messages[key] ?? []).toHaveLength(0);
  });

  it("adds the line when the server has no echo-message", () => {
    vi.spyOn(ircClient, "hasCapability").mockReturnValue(false);
    addLocalDmCopy("server1", "pm1", user, "https://host/img.png");
    const messages = useStore.getState().messages[key];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: "https://host/img.png",
      userId: "tester",
      channelId: "pm1",
      serverId: "server1",
    });
  });
});
