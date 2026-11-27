import { useMemo } from "react";
import { type MediaSettings, mediaLevelToSettings } from "../lib/mediaUtils";
import useStore from "../store";

const NO_HOSTS: readonly string[] = [];

// Every media preview surface reads its settings here, so the user's allowed
// sites always travel with the level.
export function useMediaSettings(): MediaSettings {
  const level = useStore((state) => state.globalSettings.mediaVisibilityLevel);
  const hosts =
    useStore((state) => state.globalSettings.mediaAllowedHosts) ?? NO_HOSTS;
  return useMemo(() => mediaLevelToSettings(level, hosts), [level, hosts]);
}
