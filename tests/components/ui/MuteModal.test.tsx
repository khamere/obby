import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import MuteModal from "../../../src/components/ui/MuteModal";
import { chatMute, muteChat, resetMutesForTests } from "../../../src/lib/mutes";

const open = (chat: { id: string; name: string; kind: "dm" }) =>
  render(
    <MuteModal
      isOpen
      onClose={() => {}}
      serverId="s1"
      serverName="Example"
      chat={chat}
      soundsOn
      onToggleSounds={() => {}}
    />,
  );

describe("MuteModal", () => {
  beforeEach(() => resetMutesForTests());
  afterEach(() => resetMutesForTests());

  it("shows a chat as muted when it came back under another spelling and id", () => {
    muteChat("s1", { id: "first-id", kind: "dm", name: "Mara" }, null);
    open({ id: "second-id", name: "mara", kind: "dm" });
    expect(screen.getByText("Muted until you unmute")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Unmute"));

    expect(screen.queryByText("Muted until you unmute")).toBeNull();
    expect(chatMute("s1", { kind: "dm", name: "Mara" })).toBeUndefined();
  });

  it("mutes the chat under its name", () => {
    open({ id: "second-id", name: "mara", kind: "dm" });
    fireEvent.click(screen.getAllByText("Until I unmute")[0]);
    expect(chatMute("s1", { kind: "dm", name: "MARA" })?.until).toBeNull();
  });
});
