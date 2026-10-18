import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Copy, ExternalLink, FileJson, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { api, ApiError, useServerEvent } from "../lib/api";
import { blenderPath, openInBlender, useBlenderLinks, type BlenderLink } from "../lib/blender";
import { useConfirm, useToast } from "../lib/ui";
import { ViewHeader } from "../views/ViewHeader";
import { useWorkbench } from "./store";

const RELEASES = "https://github.com/xie-hou/abt/releases/latest";

/**
 * Blender on the user's computer (the AB to T add-on linked to this repository): whether it is
 * online and what it has open, a code to link one, and this work's AB to T shots to open there.
 */
export function BlenderTab() {
  const { work, readOnly } = useWorkbench();
  const repo = work.repo;
  const links = useBlenderLinks(repo);
  const toast = useToast();
  const confirm = useConfirm();
  const [shots, setShots] = useState<string[]>([]);
  const [addon, setAddon] = useState("0.6.0");
  const [code, setCode] = useState<{ code: string; expires: string; link: string } | null>(null);
  const [pairing, setPairing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const name = repo === "local" ? "本地" : repo;
  const online = links.find((item) => item.online);

  const loadShots = useCallback(
    () =>
      api<{ shots: string[]; addon: string }>(`${blenderPath(repo)}?work=${encodeURIComponent(work.id)}`).then(
        (result) => {
          setShots(result.shots);
          setAddon(result.addon);
        },
        () => {},
      ),
    [repo, work.id],
  );
  useEffect(() => void loadShots(), [loadShots]);
  useServerEvent(
    (event) => {
      if (event.type === "work-files" && event.work === work.id && event.repo === repo && (event.files as string[]).some((file) => file.includes("/abt/")))
        void loadShots();
    },
    [loadShots],
  );

  // A code while the linking steps show; codes last ten minutes, a new one comes before that.
  const showPair = pairing || !links.length;
  const newCode = useCallback(async () => {
    try {
      setCode(await api(`${blenderPath(repo)}/pair`, { method: "POST" }));
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }, [repo, toast]);
  useEffect(() => {
    if (!showPair) return;
    void newCode();
    const timer = setInterval(() => void newCode(), 8 * 60 * 1000);
    return () => clearInterval(timer);
  }, [showPair, newCode]);
  // A linking that came through.
  const count = links.length;
  const before = useRef(count);
  useEffect(() => {
    if (count > before.current) {
      toast("Blender 已连接", "ok");
      setPairing(false);
    }
    before.current = count;
  }, [count, toast]);

  const copy = () => {
    if (!code) return;
    const done = () => toast("已复制连接码：到 Blender 的 AB to T 面板里点「连接 FRAME…」粘贴", "ok");
    if (navigator.clipboard) void navigator.clipboard.writeText(code.link).then(done, () => toast(code.link, "ok"));
    else toast(code.link, "ok");
  };

  const open = async (shot: string, reimport = false) => {
    setBusy(shot);
    try {
      const result = await openInBlender(repo, work.id, shot, reimport);
      toast(result.message.split("\n")[0], "ok");
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT" && !reimport) {
        setBusy(null);
        const again = await confirm(
          `作品里的 ${shot} 在 Blender 外面改过，和 Blender 里上次同步的版本不一样。用作品里现在的版本重新导入？Blender 里没写进 JSON 的调整会丢掉。`,
          {
            confirm: "重新导入",
            danger: true,
          },
        );
        if (again) return open(shot, true);
        return;
      }
      toast((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (link: BlenderLink) => {
    if (!(await confirm(`断开 ${link.name} 和作品库「${name}」的连接：这个作品库的 AI 不能再用它。`, { confirm: "断开", danger: true }))) return;
    api(`${blenderPath(repo)}/links/${link.id}`, { method: "DELETE" }).catch((error) => toast((error as Error).message, "error"));
  };

  const openShot = online?.state?.shot;
  return (
    <div className="view">
      <ViewHeader title="Blender" />
      <section className="view-section">
        <h3>
          <Box size={14} /> 电脑上的 Blender
        </h3>
        <p className="view-hint">
          装了 AB to T 插件的 Blender 连上作品库「{name}」后，AI 能在里面打开这个作品的三维镜头（abt-scene 技能做的）、改参数、用你电脑的显卡截图和渲染；你在
          Blender 里手调的，实时写回作品，预览跟着刷新。
        </p>
        <div className="computers">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} onUnlink={() => void unlink(link)} />
          ))}
        </div>
        {!showPair && (
          <button className="link-btn small-text" onClick={() => setPairing(true)}>
            再连接一个 Blender
          </button>
        )}
      </section>
      {showPair && (
        <section className="view-section">
          <h3>连接 Blender</h3>
          <ol className="pair-steps">
            <li>
              装 AB to T 插件 {addon} 或更新的版本：
              <a className="btn small" href={RELEASES} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> 下载 abt-&lt;版本&gt;.zip
              </a>
              ，在 Blender 里「编辑 → 偏好设置 → 获取扩展 → 右上角 ⌄ → 从磁盘安装…」选这个 zip。
            </li>
            <li>
              复制连接码：
              <button className="btn small primary" disabled={!code} onClick={copy}>
                <Copy size={12} /> 复制连接码
              </button>
              {code && (
                <span className="faint small-text">
                  {" "}
                  <span className="mono" style={{ userSelect: "all" }}>
                    {code.link}
                  </span>
                  （{new Date(code.expires).toLocaleTimeString()} 前有效，用一次）
                </span>
              )}
            </li>
            <li>
              在 Blender 的 3D 视图里按 N，打开侧边栏的「AB to T」，点「连接 FRAME…」粘贴。Blender 问能不能联网时允许（偏好设置 → 系统 → 网络 → 允许联网）。
            </li>
            <li className="faint">
              <Loader2 size={12} className="spin" /> 连上后这里会自动显示，不用刷新。
            </li>
          </ol>
          {pairing && links.length > 0 && (
            <button className="link-btn small-text" onClick={() => setPairing(false)}>
              收起
            </button>
          )}
        </section>
      )}
      <section className="view-section">
        <h3>本作品的镜头</h3>
        {shots.length ? (
          <div className="computers">
            {shots.map((shot) => {
              const here = openShot?.work === `${repo}/${work.id}` && openShot.path.endsWith(`/${shot}`);
              return (
                <div key={shot} className="computer-row">
                  <FileJson size={14} className="faint" />
                  <span className="grow ellipsis">
                    {shot}
                    {here && (
                      <span className="ok-text small-text">
                        {online?.state?.live ? " · 正在 Blender 里（实时同步）" : " · 正在 Blender 里（实时同步关着）"}
                      </span>
                    )}
                  </span>
                  <button
                    className="btn small"
                    disabled={!online || readOnly || busy !== null}
                    title={!online ? "Blender 没有连着" : readOnly ? "作品已发布，只能查看" : "在电脑上的 Blender 里打开：第一次导入，以后打开上次的 .blend"}
                    onClick={() => void open(shot)}
                  >
                    {busy === shot ? <Loader2 size={12} className="spin" /> : <Box size={12} />} 在 Blender 里打开
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="view-hint">
            这个作品还没有 AB to T 镜头（abt/&lt;镜头&gt;.json）。让 AI 用 abt-scene 技能做一个三维镜头，就能在这里打开到 Blender 里手调。
          </p>
        )}
      </section>
      <section className="view-section">
        <p className="view-hint">
          连着的 Blender 会执行这个作品库的 AI 发来的 Python 代码，代码在你的电脑上运行。不用的时候，在 Blender 的 AB to T 面板里把「连接 FRAME」关掉。.blend
          只留在你的电脑上，作品里保存的是镜头 JSON。
        </p>
      </section>
    </div>
  );
}

function LinkRow({ link, onUnlink }: { link: BlenderLink; onUnlink: () => void }) {
  const state = link.state;
  const status = link.online
    ? state?.shot
      ? `在线，开着 ${state.shot.path.split("/").slice(-2).join("/")}${state.uploading ? "，正在写回" : ""}`
      : "在线"
    : link.lastSeen
      ? `离线，上次在线 ${new Date(link.lastSeen).toLocaleString()}`
      : "离线";
  return (
    <>
      <div className="computer-row">
        <Box size={15} className={link.online ? "ok-text" : "faint"} />
        <span className="grow">
          {link.name}
          {state?.addon && <span className="faint small-text"> · AB to T {state.addon}</span>}
          <span className="faint small-text"> · {status}</span>
        </span>
        <button className="btn small danger" onClick={onUnlink}>
          断开
        </button>
      </div>
      {link.online && state?.conflict && (
        <div className="browser-note warn">
          <TriangleAlert size={14} />
          <span className="grow">{state.conflict.message}：在 Blender 的 AB to T 面板里选用哪一边。</span>
        </div>
      )}
      {link.online && state?.error && (
        <div className="browser-note warn">
          <TriangleAlert size={14} />
          <span className="grow">{state.error}</span>
        </div>
      )}
      {link.online && !!state?.activity.length && (
        <div className="computer-tabs">
          <div className="faint small-text">
            <Sparkles size={12} className="accent-text" /> 最近通过 FRAME 在 Blender 里做的
          </div>
          {state.activity.map((line, index) => (
            <div key={index} className="small-text ellipsis">
              {line}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
