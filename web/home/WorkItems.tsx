import { useState } from "react";
import { Check, Cloud, Lock, MoreHorizontal } from "lucide-react";
import { timeAgo } from "../lib/api";
import { coverUrl } from "../lib/covers";
import type { WorkSummary } from "../lib/types";
import { conflicted, formatDuration, ratioLabel } from "./model";

export interface ItemProps {
  work: WorkSummary;
  /** The repository's name, in lists that mix repositories. */
  repoLabel?: string;
  /** The repository syncs with GitHub, so sync states mean something. */
  remote: boolean;
  /** Say when the work was opened rather than changed (最近打开). */
  opened?: boolean;
  selected: boolean;
  onActivate: (event: React.MouseEvent | React.KeyboardEvent) => void;
  onToggle: (event: React.MouseEvent) => void;
  onMenu: (event: React.MouseEvent) => void;
}

/** The cover inside a frame of the work's own shape; the initial shows until (or unless) it loads. */
export function Cover({ work }: { work: WorkSummary }) {
  const cover = work.cover ? coverUrl(work.repo, work.id, work.cover) : "";
  const [broken, setBroken] = useState("");
  return (
    <div className="work-thumb-frame" style={{ aspectRatio: work.width && work.height ? `${work.width} / ${work.height}` : "16 / 9" }}>
      <span>{work.title.slice(0, 1)}</span>
      {cover && cover !== broken && <img src={cover} alt="" loading="lazy" onError={() => setBroken(cover)} />}
    </div>
  );
}

export function WorkBadges({ work, remote, repoLabel }: { work: WorkSummary; remote: boolean; repoLabel?: string }) {
  const both = work.location === "both";
  const badges = [
    repoLabel && (
      <span key="repo" className="badge work-repo ellipsis" title={`作品库：${repoLabel}`}>
        {repoLabel}
      </span>
    ),
    work.publishedAt && (
      <span key="published" className="badge accent" title={`发布于 ${new Date(work.publishedAt).toLocaleString()}，只能查看`}>
        <Lock size={9} /> 已发布
      </span>
    ),
    work.deleteRequest && (
      <span key="delete" className="badge danger" title={`AI 请求删除${work.deleteRequest.reason ? "：" + work.deleteRequest.reason : ""}`}>
        AI 请求删除
      </span>
    ),
    work.error && (
      <span key="error" className="badge danger" title={work.error}>
        无法读取
      </span>
    ),
    work.location === "remote" && (
      <span key="cloud" className="badge" title="只在 GitHub 上，打开时下载到本机">
        <Cloud size={10} /> 仅 GitHub
      </span>
    ),
    remote && work.location === "local" && (
      <span key="local" className="badge" title="还没有推送到 GitHub">
        仅本机
      </span>
    ),
    remote && both && work.remoteNewer && work.synced && (
      <span key="newer" className="badge warn" title="GitHub 上有更新的版本（来自其他设备）。打开作品时会更新到最新版本。">
        GitHub 有更新
      </span>
    ),
    remote && conflicted(work) && (
      <span key="conflict" className="badge danger" title="本机和 GitHub 上都有新的版本。打开作品后选择合并双方、采用 GitHub 的版本或保留本机的版本。">
        冲突
      </span>
    ),
    remote && both && !work.synced && !work.remoteNewer && (
      <span key="unsynced" className="badge warn" title="本机有还没推送到 GitHub 的版本（保存版本后会自动推送）">
        未同步
      </span>
    ),
  ].filter(Boolean);
  return badges.length ? <span className="work-badges">{badges}</span> : null;
}

const when = (work: WorkSummary, opened?: boolean) => (opened && work.openedAt ? `${timeAgo(work.openedAt)}打开` : timeAgo(work.updatedAt));

function SelectBox({ selected, onToggle }: Pick<ItemProps, "selected" | "onToggle">) {
  return (
    <button
      className="work-check"
      role="checkbox"
      aria-checked={selected}
      aria-label="选择"
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event);
      }}
    >
      {selected && <Check size={13} strokeWidth={3} />}
    </button>
  );
}

function MenuButton({ onMenu }: Pick<ItemProps, "onMenu">) {
  return (
    <button
      className="icon-btn"
      aria-label="更多"
      onClick={(event) => {
        event.stopPropagation();
        onMenu(event);
      }}
    >
      <MoreHorizontal size={15} />
    </button>
  );
}

export function WorkCard({ work, repoLabel, remote, opened, selected, onActivate, onToggle, onMenu }: ItemProps) {
  const meta = [formatDuration(work.duration), ratioLabel(work.width, work.height), when(work, opened)].filter(Boolean).join(" · ");
  return (
    <div
      className={`work-card ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => event.key === "Enter" && onActivate(event)}
      onContextMenu={onMenu}
    >
      <div className="work-thumb" style={{ "--accent": work.accent || "var(--accent)" } as React.CSSProperties}>
        <Cover work={work} />
        <SelectBox selected={selected} onToggle={onToggle} />
      </div>
      <div className="work-info">
        <div className="row">
          <strong className="ellipsis grow" title={work.title}>
            {work.title}
          </strong>
          <MenuButton onMenu={onMenu} />
        </div>
        <div className="work-meta ellipsis" title={`${work.width}×${work.height}`}>
          {meta}
        </div>
        <WorkBadges work={work} remote={remote} repoLabel={repoLabel} />
      </div>
    </div>
  );
}

export function WorkListHead({ repo, opened }: { repo: boolean; opened?: boolean }) {
  return (
    <div className="work-row work-row-head" aria-hidden="true">
      <span />
      <span />
      <span>名称</span>
      {repo && <span className="col-repo">作品库</span>}
      <span className="col-size">画幅</span>
      <span className="col-duration">时长</span>
      <span className="col-status">状态</span>
      <span className="col-time">{opened ? "打开时间" : "修改时间"}</span>
      <span />
    </div>
  );
}

export function WorkRow({ work, repoLabel, showRepo, remote, opened, selected, onActivate, onToggle, onMenu }: ItemProps & { showRepo: boolean }) {
  return (
    <div
      className={`work-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => event.key === "Enter" && onActivate(event)}
      onContextMenu={onMenu}
    >
      <SelectBox selected={selected} onToggle={onToggle} />
      <div className="work-row-thumb">
        <Cover work={work} />
      </div>
      <div className="work-row-title">
        <strong className="ellipsis" title={work.title}>
          {work.title}
        </strong>
        {(work.subtitle || work.description) && <span className="faint ellipsis">{work.subtitle || work.description}</span>}
      </div>
      {showRepo && <span className="col-repo ellipsis muted">{repoLabel}</span>}
      <span className="col-size muted" title={`${work.width}×${work.height}`}>
        {ratioLabel(work.width, work.height)}
      </span>
      <span className="col-duration muted">{formatDuration(work.duration)}</span>
      <span className="col-status">
        <WorkBadges work={work} remote={remote} />
      </span>
      <span className="col-time muted" title={new Date((opened && work.openedAt) || work.updatedAt).toLocaleString()}>
        {when(work, opened)}
      </span>
      <MenuButton onMenu={onMenu} />
    </div>
  );
}
