import { useEffect, useState } from "react";
import { savedReply } from "../lib/jumpToReply";
import type { SavedMessage } from "../store/handlers/history";

// The saved copy of the message a reply points at, when the original is not
// loaded: null while it is being looked up or when there is none.
export function useSavedReply(
  serverId: string,
  channelId: string,
  msgid: string | null,
): SavedMessage | null {
  const [saved, setSaved] = useState<SavedMessage | null>(null);
  useEffect(() => {
    setSaved(null);
    if (!msgid) return;
    let live = true;
    savedReply(serverId, channelId, msgid).then((found) => {
      if (live) setSaved(found);
    });
    return () => {
      live = false;
    };
  }, [serverId, channelId, msgid]);
  return saved;
}
