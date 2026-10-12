import { useState } from "react";
import { AudioLines, BarChart3, BookOpen, Clapperboard, GitBranch, Library, RefreshCw, Shapes } from "lucide-react";
import { api } from "../lib/api";
import { useWorkbench, type Tool, type VersionSource } from "./store";
import { DiffEditor } from "./DiffEditor";
import { LibrariesTab } from "./LibrariesTab";
import { ExportView } from "../views/ExportView";
import { ReviewView } from "../views/ReviewView";
import { AudioView } from "../views/AudioView";
import { ResourcesPanel } from "../views/ResourcesPanel";
import { VersionsPanel, SOURCE_NAMES, versionsBase } from "../views/VersionsView";
import { usePlacement } from "../views/placement";

export const TOOL_TITLES: Record<Tool, string> = {
  export: "导出",
  reviews: "复盘",
  audio: "音频与配音",
  resources: "资源",
  "versions:work": "版本 · 作品",
  "versions:experience": "版本 · 经验库",
  "versions:materials": "版本 · 素材库",
  "versions:reviews": "版本 · 复盘资料",
  "libraries:materials": "素材库",
  "libraries:experiences": "经验库",
};

export function toolIcon(tool: Tool, size = 14) {
  if (tool.startsWith("versions:")) return <GitBranch size={size} />;
  if (tool === "libraries:materials") return <Library size={size} />;
  if (tool === "libraries:experiences") return <BookOpen size={size} />;
  if (tool === "export") return <Clapperboard size={size} />;
  if (tool === "reviews") return <BarChart3 size={size} />;
  if (tool === "audio") return <AudioLines size={size} />;
  return <Shapes size={size} />;
}

/** A tool as an editor tab: wide, with room for its options and data. */
export function ToolTab({ tool }: { tool: Tool }) {
  if (tool.startsWith("versions:")) return <VersionsTab source={tool.slice("versions:".length) as VersionSource} />;
  if (tool === "libraries:materials" || tool === "libraries:experiences") return <LibrariesTab kind={tool === "libraries:materials" ? "materials" : "experiences"} />;
  if (tool === "resources") return <ResourcesTab />;
  // Forms and lists made for a narrow column: centered, wider where their data wants it.
  return (
    <div className={`tool-page tool-column ${tool === "reviews" ? "wide" : ""}`}>
      {tool === "export" ? <ExportView /> : tool === "reviews" ? <ReviewView /> : <AudioView />}
    </div>
  );
}

/**
 * Versions of the work or a shared branch: saving, unsaved changes, history and GitHub sync on
 * the left, the change picked there on the right.
 */
function VersionsTab({ source }: { source: VersionSource }) {
  const { work } = useWorkbench();
  const [shown, setShown] = useState<{ title: string; query: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const base = versionsBase(source, work.repo, work.id);
  return (
    <div className="tool-page versions-tab">
      <div className="versions-side">
        <header className="tab-head compact">
          <GitBranch size={16} />
          <h2>{SOURCE_NAMES[source]}的版本与同步</h2>
          <span className="grow" />
          <button
            className="icon-btn"
            title="刷新，并和 GitHub 比较"
            onClick={() =>
              Promise.all([api(`${base}/sync`, { method: "POST" }), api(`${base}/remote/check`, { method: "POST" })]).then(
                () => setRefresh(Date.now()),
                () => setRefresh(Date.now()),
              )
            }
          >
            <RefreshCw size={15} />
          </button>
        </header>
        <div className="versions-list">
          <VersionsPanel source={source} refresh={refresh} onShow={(title, query) => setShown({ title, query })} selected={shown?.query} />
        </div>
      </div>
      <div className="versions-main">
        {shown ? (
          <>
            <div className="editor-toolbar">
              <span className="small-text ellipsis grow">{shown.title}</span>
            </div>
            <DiffEditor key={shown.query} query={shown.query} source={source} />
          </>
        ) : (
          <div className="tab-empty">在左边选一个未保存的修改或历史版本，这里显示它改了什么。</div>
        )}
      </div>
    </div>
  );
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
