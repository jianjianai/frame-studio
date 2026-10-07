import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CloudDownload, GitMerge, RefreshCw, Loader2 } from "lucide-react";
import { api, useServerEvent, type ApiError } from "../lib/api";
import { useConfirm, useToast } from "../lib/ui";

/** How a work (or library branch) stands against GitHub; see server/remote-sync.mjs. */
export interface RemoteState {
  state: "synced" | "pushing" | "behind" | "diverged" | "conflict" | "error" | "local" | "unknown";
  ahead?: number;
  behind?: number;
  /** Versions just brought in from GitHub. */
  pulled?: number;
  /** Unsaved files that kept GitHub's versions from being brought in. */
  blocked?: string[];
  /** Files both sides changed (a merge failed). */
  files?: string[];
  waiting?: "ai";
  message?: string;
  at?: string;
}

/**
 * The remote state of `scope` (a work id, or experience-<repo> / materials-<repo>) from the
 * API under `base` (…/remote). With `check`, it is compared with GitHub when shown (opening
 * the work or panel); otherwise only by a manual refresh and when versions are pushed —
 * the events bring every result.
 */
export function useRemoteState(base: string, repo: string, scope: string, { check: checkOnOpen = false } = {}) {
  const [state, setState] = useState<RemoteState | null>(null);
  const check = useCallback(() => api<RemoteState>(`${base}/check`, { method: "POST" }).then(setState, () => {}), [base]);
  useEffect(() => {
    if (checkOnOpen) void check();
    else void api<RemoteState>(base).then(setState, () => {});
  }, [base, checkOnOpen, check]);
  useServerEvent(
    (event) => {
      if (event.type === "remote-state" && event.repo === repo && event.work === scope) setState(event.state as RemoteState);
    },
    [repo, scope],
  );
  return [state, check, setState] as const;
}

/**
 * The warning above the editor when GitHub has newer versions or both sides changed, with
 * the ways out, so nobody keeps editing an outdated copy. `what` names it: 作品, 经验库, 素材库.
 */
export function RemoteBar({
  base,
  repo,
  scope,
  what = "作品",
  onSettled,
}: {
  base: string;
  repo: string;
  scope: string;
  what?: string;
  onSettled?: () => void;
}) {
  const [state, check, setState] = useRemoteState(base, repo, scope, { check: true });
  // Paths come from the branch root: a work's files are shown as in its folder.
  const names = (files: string[] = []) => files.map((file) => file.replace(/^projects\/[^/]+\//, "")).join("、");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  // Updates brought in without asking are announced once.
  const announced = useRef("");
  useEffect(() => {
    if (state?.pulled && state.at && announced.current !== state.at) {
      announced.current = state.at;
      toast(`已从 GitHub 更新到最新版本（${state.pulled} 个新版本，来自其他设备）`, "ok");
    }
  }, [state, toast]);

  const settle = async (strategy: "update" | "merge" | "remote" | "local") => {
    if (
      strategy === "remote" &&
      !(await confirm(`改用 GitHub 上的${what}？本机的新版本和未保存的修改会另存为备份，${what}回到 GitHub 上的样子。`, {
        confirm: "采用 GitHub 的版本",
        danger: true,
      }))
    )
      return;
    if (
      strategy === "local" &&
      !(await confirm(`保留本机的${what}？GitHub 上那些新版本的修改不会出现在${what}里（仍保留在历史中），本机的版本会推送到 GitHub。`, {
        confirm: "保留本机的版本",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      setState(await api<RemoteState>(`${base}/settle`, { body: { strategy } }));
      onSettled?.();
    } catch (error) {
      const files = ((error as ApiError).details as { files?: string[] } | undefined)?.files;
      setState({ state: "conflict", ahead: state?.ahead, behind: state?.behind, files: files ?? [] });
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const spin = busy ? <Loader2 size={13} className="spin" /> : null;
  if (state.state === "behind")
    return (
      <div className="remote-bar warn" role="alert">
        <CloudDownload size={15} />
        <span className="grow">
          <strong>GitHub 上有更新的版本</strong>（{state.behind} 个，来自其他设备或对话），本机的{what}是旧的。
          {state.waiting === "ai"
            ? " AI 正在工作，这一轮结束后会自动更新；在那之前先不要修改。"
            : state.blocked?.length
              ? ` 本机未保存的修改和它们改了同样的文件（${names(state.blocked)}）：保存本机的修改并合并后再继续编辑。`
              : " 更新后再继续编辑，避免在旧版本上修改。"}
        </span>
        {state.waiting !== "ai" && (
          <button className="btn small primary" disabled={busy} onClick={() => settle("update")}>
            {spin}
            {state.blocked?.length ? "保存并合并" : "更新到最新版本"}
          </button>
        )}
      </div>
    );
  if (state.state === "diverged" || state.state === "conflict")
    return (
      <div className="remote-bar danger" role="alert">
        <AlertTriangle size={15} />
        <span className="grow">
          <strong>冲突：本机和 GitHub 上都有新的版本</strong>（本机 {state.ahead ?? "?"} 个，GitHub {state.behind ?? "?"} 个）。
          {state.state === "conflict"
            ? ` 双方改了同一处内容，无法自动合并${state.files?.length ? `：${names(state.files)}` : ""}。选择保留哪一边：`
            : " 先处理再继续编辑，避免两边越改越远："}
        </span>
        {state.state === "diverged" && (
          <button className="btn small primary" disabled={busy} onClick={() => settle("merge")}>
            {spin}
            <GitMerge size={13} /> 合并双方
          </button>
        )}
        <button className="btn small" disabled={busy} onClick={() => settle("remote")}>
          采用 GitHub 的版本
        </button>
        <button className="btn small" disabled={busy} onClick={() => settle("local")}>
          保留本机的版本
        </button>
      </div>
    );
  if (state.state === "error")
    return (
      <div className="remote-bar warn" role="status">
        <AlertTriangle size={14} />
        <span className="grow ellipsis" title={state.message}>
          {state.message || "和 GitHub 同步失败"}
        </span>
        <button className="btn small" onClick={() => void check()}>
          <RefreshCw size={13} /> 重试
        </button>
      </div>
    );
  return null;
}
