import { moveChannelHistory } from "../lib/history/historyDb";
import { saveLeftReason } from "../lib/leftChannels";
import { moveChatMute } from "../lib/mutes";
import { renameRecentPlace } from "../lib/search/recents";
import { useChannelFolders } from "./channelFolders";
import * as storage from "./localStorage";

/** A list of channel names with the renamed channel in its old place, once. */
export function withRenamedChannel(
  names: string[],
  oldName: string,
  newName: string,
): string[] {
  const isNamed = (wanted: string) => (name: unknown) =>
    typeof name === "string" && name.toLowerCase() === wanted.toLowerCase();
  const at = names.findIndex(isNamed(oldName));
  if (at === -1) return names;
  return names.flatMap((name, index) => {
    if (index === at) return [newName];
    return isNamed(oldName)(name) || isNamed(newName)(name) ? [] : [name];
  });
}

function renameInSavedServer(
  serverId: string,
  oldName: string,
  newName: string,
) {
  const savedServers = storage.servers.load();
  const savedServer = savedServers.find((s) => s.id === serverId);
  if (!savedServer || !Array.isArray(savedServer.channels)) return;
  const channels = withRenamedChannel(savedServer.channels, oldName, newName);
  if (channels === savedServer.channels) return;
  savedServer.channels = channels;
  storage.servers.save(savedServers);
}

function renameInFolders(serverId: string, oldName: string, newName: string) {
  const { folders, setFolders } = useChannelFolders.getState();
  const current = folders[serverId] ?? [];
  const renamed = current.map((folder) => {
    const channels = withRenamedChannel(folder.channels, oldName, newName);
    return channels === folder.channels ? folder : { ...folder, channels };
  });
  if (renamed.some((folder, index) => folder !== current[index]))
    setFolders(serverId, renamed);
}

function renameInSavedSelection(
  serverId: string,
  host: string,
  oldName: string,
  newName: string,
) {
  const isOld = (name: string | null | undefined) =>
    name?.toLowerCase() === oldName.toLowerCase();
  const selections = storage.uiSelections.load();
  const selection = selections.perServerSelections?.[serverId];
  const last = selections.lastSelection;
  const isLast = !!last && last.serverHost === host && isOld(last.channelName);
  if (!isOld(selection?.selectedChannelName) && !isLast) return;
  storage.uiSelections.save({
    ...selections,
    perServerSelections:
      selection && isOld(selection.selectedChannelName)
        ? {
            ...selections.perServerSelections,
            [serverId]: { ...selection, selectedChannelName: newName },
          }
        : selections.perServerSelections,
    lastSelection: isLast ? { ...last, channelName: newName } : last,
  });
}

/** Everything we save by a channel's name outside the store takes the name the server gave the channel, so the next page load finds the channel where it is now. */
export function carrySavedChannelName(
  serverId: string,
  host: string,
  oldName: string,
  newName: string,
): void {
  moveChatMute(serverId, "channel", oldName, newName);
  // We are in the channel under its new name, so a mark that says we left a channel of that name goes.
  saveLeftReason(serverId, newName, undefined);
  renameRecentPlace(serverId, oldName, newName);
  void moveChannelHistory(serverId, oldName, newName).catch(() => undefined);
  try {
    renameInSavedServer(serverId, oldName, newName);
    renameInFolders(serverId, oldName, newName);
    renameInSavedSelection(serverId, host, oldName, newName);
  } catch {
    // Storage is full or closed to us, and the channel still carries its new name until the page reloads.
  }
}
