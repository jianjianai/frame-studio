import { BarChart3, BookOpen, Box, Clapperboard, Globe, Library, Shapes } from "lucide-react";
import type { Tool } from "./store";
import { LibrariesTab } from "./LibrariesTab";
import { BrowserTab } from "./BrowserTab";
import { BlenderTab } from "./BlenderTab";
import { ExportView } from "../views/ExportView";
import { ReviewView } from "../views/ReviewView";
import { ResourcesPanel } from "../views/ResourcesPanel";
import { usePlacement } from "../views/placement";

export const TOOL_TITLES: Record<Tool, string> = {
  export: "导出",
  reviews: "复盘",
  resources: "资源",
  "libraries:materials": "素材库",
  "libraries:experiences": "经验库",
  browser: "浏览器",
  blender: "Blender",
};

export function toolIcon(tool: Tool, size = 14) {
  if (tool === "libraries:materials") return <Library size={size} />;
  if (tool === "libraries:experiences") return <BookOpen size={size} />;
  if (tool === "export") return <Clapperboard size={size} />;
  if (tool === "reviews") return <BarChart3 size={size} />;
  if (tool === "browser") return <Globe size={size} />;
  if (tool === "blender") return <Box size={size} />;
  return <Shapes size={size} />;
}

/** A tool as an editor tab: wide, with room for its options and data. */
export function ToolTab({ tool }: { tool: Tool }) {
  if (tool === "libraries:materials" || tool === "libraries:experiences") return <LibrariesTab kind={tool === "libraries:materials" ? "materials" : "experiences"} />;
  if (tool === "resources") return <ResourcesTab />;
  if (tool === "browser") return <BrowserTab />;
  if (tool === "blender")
    return (
      <div className="tool-page tool-column">
        <BlenderTab />
      </div>
    );
  // Forms and lists made for a narrow column: centered, wider where their data wants it.
  return <div className={`tool-page tool-column ${tool === "reviews" ? "wide" : ""}`}>{tool === "export" ? <ExportView /> : <ReviewView />}</div>;
}

/** The resources and sounds the material libraries declare, searched and previewed in a wide grid. */
function ResourcesTab() {
  const { placeSound } = usePlacement();
  return (
    <div className="tool-page resources-tab">
      <ResourcesPanel onPlaceSound={placeSound} />
    </div>
  );
}
