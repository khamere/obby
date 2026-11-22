import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelKeyModal } from "../../../src/components/ui/ChannelKeyModal";
import ircClient from "../../../src/lib/ircClient";
import type { AppState } from "../../../src/store";
import useStore from "../../../src/store";

const SERVER = "srv-1";

describe("ChannelKeyModal", () => {
  beforeEach(() => {
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.set(
      SERVER,
      { id: SERVER, channels: [], capabilities: [] },
    );
    useStore.setState({
      servers: [
        {
          id: SERVER,
          name: "Test",
          host: "irc.test",
          port: 6667,
          channels: [],
          privateChats: [],
          users: [],
          isConnected: true,
        },
      ],
      channelKeyPrompt: {
        serverId: SERVER,
        channelName: "#vault",
        isWrongKey: false,
      },
    } as Partial<AppState>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ channelKeyPrompt: null });
    (ircClient as unknown as { servers: Map<string, unknown> }).servers.delete(
      SERVER,
    );
  });

  it("joins with the key the user enters", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    render(<ChannelKeyModal />);

    fireEvent.change(screen.getByLabelText("Channel key"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(sendRaw).toHaveBeenCalledWith(SERVER, "JOIN #vault hunter2");
    expect(useStore.getState().channelKeyPrompt).toBeNull();
  });

  it.each([
    ["two words", "JOIN #vault :two words"],
    [" hunter2\u00a0 ", "JOIN #vault hunter2\u00a0"],
    ["secret ", "JOIN #vault secret"],
    ["  two words ", "JOIN #vault :two words"],
    [":secret", "JOIN #vault ::secret"],
  ])(
    "sends the key %j without the spaces around it and closes",
    (key, line) => {
      const sendRaw = vi
        .spyOn(ircClient, "sendRaw")
        .mockImplementation(() => {});
      render(<ChannelKeyModal />);

      fireEvent.change(screen.getByLabelText("Channel key"), {
        target: { value: key },
      });
      fireEvent.click(screen.getByRole("button", { name: "Join" }));

      expect(sendRaw).toHaveBeenCalledWith(SERVER, line);
      expect(useStore.getState().channelKeyPrompt).toBeNull();
    },
  );

  it("keeps the prompt open for a key with a comma and sends nothing", () => {
    const sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    render(<ChannelKeyModal />);

    fireEvent.change(screen.getByLabelText("Channel key"), {
      target: { value: "hunter2,other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(sendRaw).not.toHaveBeenCalled();
    expect(useStore.getState().channelKeyPrompt).not.toBeNull();
    expect(screen.getByLabelText("Channel key")).toBeInvalid();
    expect(screen.getByLabelText("Channel key")).toHaveAccessibleDescription(
      "Enter a key without commas",
    );
    expect(screen.queryByText("Wrong key, try again")).not.toBeInTheDocument();
  });

  it("tells the user when the last key was wrong", () => {
    useStore.setState({
      channelKeyPrompt: {
        serverId: SERVER,
        channelName: "#vault",
        isWrongKey: true,
      },
    });
    render(<ChannelKeyModal />);

    expect(screen.getByText("Wrong key, try again")).toBeInTheDocument();
  });
});
