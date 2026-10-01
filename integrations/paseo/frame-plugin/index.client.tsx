import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeFrameClient, FramePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "work",
    title: "Frame 作品",
    icon: "Film",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: FramePanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "work",
    title: "打开 Frame 作品工具",
    icon: "Film",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("work");
    },
  });
  const removeButtons = contributeFrameClient(client);
  return () => {
    removeButtons();
    removeCommand();
    removePanel();
  };
}
