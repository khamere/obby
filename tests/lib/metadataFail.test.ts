import { describe, expect, test, vi } from "vitest";
import { handleMetadataFail } from "../../src/lib/irc/handlers/metadata";
import type { IRCClientContext } from "../../src/lib/irc/IRCClientContext";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";

function makeCtx() {
  const triggered: { event: string; data: unknown }[] = [];
  const ctx = {
    triggerEvent: vi.fn((event: string, data: unknown) =>
      triggered.push({ event, data }),
    ),
  } as unknown as IRCClientContext;
  return { ctx, triggered };
}

describe("handleMetadataFail — Standard Replies parsing", () => {
  test("parses KEY_INVALID with key context", () => {
    const { ctx, triggered } = makeCtx();
    // parv: [METADATA, KEY_INVALID, url, invalid key]
    handleMetadataFail(
      ctx,
      "srv-1",
      "server",
      ["METADATA", "KEY_INVALID", "url", "invalid key"],
      undefined,
      "invalid key",
    );

    expect(triggered).toHaveLength(1);
    expect(triggered[0].event).toBe("METADATA_FAIL");
    expect(triggered[0].data).toEqual({
      serverId: "srv-1",
      subcommand: undefined,
      code: "KEY_INVALID",
      target: undefined,
      key: "url",
      retryAfter: undefined,
      description: "invalid key",
    });
  });

  test("parses KEY_NO_PERMISSION with target and key context", () => {
    const { ctx, triggered } = makeCtx();
    handleMetadataFail(
      ctx,
      "srv-1",
      "server",
      [
        "METADATA",
        "KEY_NO_PERMISSION",
        "#channel",
        "avatar",
        "permission denied",
      ],
      undefined,
      "permission denied",
    );

    expect(triggered[0].data).toEqual({
      serverId: "srv-1",
      subcommand: undefined,
      code: "KEY_NO_PERMISSION",
      target: "#channel",
      key: "avatar",
      retryAfter: undefined,
      description: "permission denied",
    });
  });

  test("parses RATE_LIMITED with target, key, and retryAfter", () => {
    const { ctx, triggered } = makeCtx();
    handleMetadataFail(
      ctx,
      "srv-1",
      "server",
      ["METADATA", "RATE_LIMITED", "*", "status", "10", "too many changes"],
      undefined,
      "too many changes",
    );

    expect(triggered[0].data).toEqual({
      serverId: "srv-1",
      subcommand: undefined,
      code: "RATE_LIMITED",
      target: "*",
      key: "status",
      retryAfter: 10,
      description: "too many changes",
    });
  });

  test("parses non-standard FAIL METADATA <subcommand> <code> format", () => {
    const { ctx, triggered } = makeCtx();
    handleMetadataFail(
      ctx,
      "srv-1",
      "server",
      ["METADATA", "SET", "KEY_INVALID", "*", "url", "invalid key"],
      undefined,
      "invalid key",
    );

    expect(triggered[0].data).toEqual({
      serverId: "srv-1",
      subcommand: "SET",
      code: "KEY_INVALID",
      target: "*",
      key: "url",
      retryAfter: undefined,
      description: "invalid key",
    });
  });

  test("dispatches over wire without calling console.error", () => {
    useStore.getState();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleDebugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => {});

    let receivedEvent: unknown;
    const listener = (data: unknown) => {
      receivedEvent = data;
    };
    ircClient.on("METADATA_FAIL", listener);

    try {
      (
        ircClient as unknown as {
          handleMessage(data: string, serverId: string): void;
        }
      ).handleMessage(
        ":irc.test FAIL METADATA KEY_INVALID url :invalid key\r\n",
        "srv-1",
      );

      expect(receivedEvent).toMatchObject({
        serverId: "srv-1",
        code: "KEY_INVALID",
        key: "url",
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleDebugSpy).toHaveBeenCalled();
    } finally {
      ircClient.deleteHook("METADATA_FAIL", listener);
      consoleErrorSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    }
  });

  test("handles 762 RPL_METADATAEND numeric over wire", () => {
    let receivedEvent: unknown;
    const listener = (data: unknown) => {
      receivedEvent = data;
    };
    ircClient.on("METADATA_END", listener);

    try {
      (
        ircClient as unknown as {
          handleMessage(data: string, serverId: string): void;
        }
      ).handleMessage(
        ":irc.test 762 testnick #mychannel :end of metadata\r\n",
        "srv-1",
      );

      expect(receivedEvent).toEqual({
        serverId: "srv-1",
        target: "#mychannel",
      });
    } finally {
      ircClient.deleteHook("METADATA_END", listener);
    }
  });

  test("cleans up channelMetadataFetchQueue and sets fetchedAt on METADATA_END", () => {
    useStore.setState({
      channelMetadataFetchQueue: {
        "srv-1": new Set(["#mychannel"]),
      },
      channelMetadataCache: {
        "srv-1": {},
      },
    });

    ircClient.triggerEvent("METADATA_END", {
      serverId: "srv-1",
      target: "#mychannel",
    });

    const state = useStore.getState();
    expect(state.channelMetadataFetchQueue["srv-1"]?.has("#mychannel")).toBe(
      false,
    );
    expect(
      state.channelMetadataCache["srv-1"]?.["#mychannel"]?.fetchedAt,
    ).toBeDefined();
  });

  test("cleans up channelMetadataFetchQueue on channel METADATA_FAIL", () => {
    useStore.setState({
      channelMetadataFetchQueue: {
        "srv-1": new Set(["#badchannel"]),
      },
    });

    ircClient.triggerEvent("METADATA_FAIL", {
      serverId: "srv-1",
      code: "INVALID_TARGET",
      target: "#badchannel",
      description: "Invalid target",
    });

    const state = useStore.getState();
    expect(state.channelMetadataFetchQueue["srv-1"]?.has("#badchannel")).toBe(
      false,
    );
  });
});
