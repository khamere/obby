import { t } from "@lingui/core/macro";
import type * as React from "react";
import {
  FaArrowsAltV,
  FaCog,
  FaFolderPlus,
  FaList,
  FaPowerOff,
  FaTerminal,
  FaTrash,
} from "react-icons/fa";
import useStore from "../../store";
import Menu from "../ui/Menu";

interface NetworkMenuProps {
  serverId: string;
  anchor: HTMLElement | null;
  isTouch: boolean;
  onClose: () => void;
  onNewFolder: () => void;
  onReorder: () => void;
}

export function editConnection(serverId: string, section?: "auth") {
  const store = useStore.getState();
  const server = store.servers.find((s) => s.id === serverId);
  if (server?.bouncerNetid) store.editBouncerNetwork(serverId);
  else store.openPage({ kind: "serverSettings", serverId, section });
}

export const NetworkMenu: React.FC<NetworkMenuProps> = ({
  serverId,
  anchor,
  isTouch,
  onClose,
  onNewFolder,
  onReorder,
}) => {
  const store = useStore.getState();
  // A bound network has no connection of its own to drop: the bouncer holds
  // it, and the only way out of the list is to delete it there.
  const isBouncerNetwork = !!store.servers.find((s) => s.id === serverId)
    ?.bouncerNetid;
  return (
    <Menu
      isOpen={!!anchor}
      anchorElement={anchor}
      width={anchor ? Math.round(anchor.getBoundingClientRect().width) : "auto"}
      onClose={onClose}
      menuItems={[
        {
          id: "find",
          label: t`Find channels`,
          icon: <FaList />,
          show: true,
          onClick: () => store.openPage({ kind: "channelBrowser", serverId }),
        },
        {
          id: "folder",
          label: t`Create folder`,
          icon: <FaFolderPlus />,
          show: true,
          onClick: onNewFolder,
        },
        {
          id: "reorder",
          label: t`Reorder list`,
          icon: <FaArrowsAltV />,
          show: isTouch,
          onClick: onReorder,
        },
        {
          id: "rawlog",
          label: t`Raw log`,
          icon: <FaTerminal />,
          show: true,
          onClick: () => store.openPage({ kind: "rawLog", serverId }),
        },
        {
          id: "edit",
          label: t`Edit connection`,
          icon: <FaCog />,
          show: true,
          divider: true,
          onClick: () => editConnection(serverId),
        },
        {
          id: "disconnect",
          label: isBouncerNetwork ? t`Delete network` : t`Disconnect`,
          icon: isBouncerNetwork ? <FaTrash /> : <FaPowerOff />,
          show: true,
          danger: true,
          onClick: () => store.requestDeleteServer(serverId),
        },
      ]}
    />
  );
};

export default NetworkMenu;
