import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  Boxes,
  Clapperboard,
  Film,
  FolderOpen,
  Layers3,
  Play,
  Search,
  Sparkles,
  Terminal,
  Download,
  CheckCircle2,
  Cpu,
  Music2,
  Image as ImageIcon,
} from "lucide-react";
import { projects, findProject } from "./projects";
import { assetUrl } from "./engine/types";
import { formatTime } from "./engine/math";
import { Player } from "./ui/Player";
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}
export default function App() {
  const route = useRoute();
  const project = route.startsWith("/film/")
    ? findProject(route.slice(6))
    : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-symbol">
            F<span />
          </span>
          <div>
            <strong>
              FRAME<span>®</span>
            </strong>
            <small>动画工坊</small>
          </div>
        </a>
        <div className="workspace-tag">
          <i /> REALTIME STUDIO <span>01</span>
        </div>
        <div className="nav-caption">工作空间</div>
        <nav className="main-nav">
          <a className={route === "/" ? "selected" : ""} href="#/">
            <Film size={18} /> 作品库{" "}
            <span>{projects.length.toString().padStart(2, "0")}</span>
          </a>
          <a className={route === "/assets" ? "selected" : ""} href="#/assets">
            <Layers3 size={18} /> 素材库
          </a>
          <a className={route === "/guide" ? "selected" : ""} href="#/guide">
            <BookOpen size={18} /> 制作指南
          </a>
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption">动画项目</div>
        <nav className="project-nav">
          {projects.map((p, i) => (
            <a
              key={p.id}
              className={project?.id === p.id ? "selected" : ""}
              href={"#/film/" + p.id}
            >
              <span className="project-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <i style={{ background: p.accent }} />
              <span>{p.title}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-mark">
            <Boxes size={17} /> 一个项目，持续生长。
          </div>
          <p>
            渲染、素材、音乐和时间轴，
            <br />
            为每一个新故事复用。
          </p>
          <div className="local-status">
            <i /> 本地工作区 <span>v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <div className="topbar">
          <span>
            工作空间 <span className="slash">/</span>{" "}
            <strong>
              {project
                ? "动画工作台"
                : route === "/assets"
                  ? "素材库"
                  : route === "/guide"
                    ? "制作指南"
                    : "作品库"}
            </strong>
          </span>
          <div>
            <span className="runtime-badge">
              <i /> 实时渲染引擎
            </span>
            <span className="avatar">F.</span>
          </div>
        </div>
        {project ? (
          <Player key={project.id} project={project} />
        ) : route === "/assets" ? (
          <AssetLibrary />
        ) : route === "/guide" ? (
          <Guide />
        ) : route === "/" ? (
          <Gallery />
        ) : (
          <div className="empty-state">
            <h1>没有找到这部动画</h1>
            <p>项目可能已改名，请从作品库重新选择。</p>
            <a className="button" href="#/">
              返回作品库
            </a>
          </div>
        )}
        <footer className="app-footer">
          <span>FRAME STUDIO</span>
          <span>让动画承担叙事，而不是装饰文字。</span>
          <span>CODE → MOTION → STORY</span>
        </footer>
      </main>
    </div>
  );
}
function Gallery() {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const featured = findProject("sunny-rail") ?? projects[0];
  const shown = projects.filter(
    (p) =>
      (filter === "all" || p.renderer === filter) &&
      [p.title, p.subtitle, ...p.tags]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="library-page">
      <header className="library-heading">
        <div>
          <div className="eyebrow">YOUR CREATIVE WORKSPACE</div>
          <h1>
            作品库<span> / {projects.length.toString().padStart(2, "0")}</span>
          </h1>
          <p>从一个好镜头开始，让每个故事拥有自己的生命。</p>
        </div>
        <a className="button primary" href="#/guide">
          <Sparkles size={16} /> 制作新动画 <ArrowUpRight size={16} />
        </a>
      </header>
      {featured && (
        <section className="hero-banner">
          <div className="hero-copy">
            <span className="eyebrow">
              <i /> FRAME / ENGINE DEMOS
            </span>
            <h2>
              让故事，
              <br />
              <em>真正动起来。</em>
            </h2>
            <p>
              不再从一张空白 HTML 开始。
              <br />
              在同一个工作台，让素材、动作、镜头与声音相遇。
            </p>
            <a href={"#/film/" + featured.id} className="hero-link">
              <span>
                <Play size={17} fill="currentColor" />
              </span>{" "}
              播放《{featured.title}》
              <ArrowRight size={17} />
            </a>
            <div className="hero-footnote">
              {featured.duration} SEC <b>—</b>{" "}
              {featured.renderer === "three"
                ? "THREE.JS"
                : featured.renderer.toUpperCase()}{" "}
              <b>—</b> ORIGINAL DEMO
            </div>
          </div>
          <a
            className="hero-art"
            href={"#/film/" + featured.id}
            aria-label={"播放" + featured.title}
          >
            <img
              src={assetUrl(featured.poster)}
              alt={featured.title + " · 作品封面"}
            />
            <span className="art-label">
              <span>
                {featured.id === "sunny-rail"
                  ? "ISLAND EXPRESS"
                  : featured.title}
              </span>
              <small>A SMALL WORLD, IN MOTION.</small>
            </span>
            <span className="art-corner">
              <ArrowUpRight size={24} />
            </span>
          </a>
        </section>
      )}
      <div className="library-toolbar">
        <div className="filter-tabs">
          {[
            ["all", "全部作品"],
            ["pixi", "2D 插画"],
            ["three", "3D 场景"],
            ["canvas", "矢量动画"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
              {value === "all" && <span>{projects.length}</span>}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="搜索动画…"
            aria-label="搜索动画"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="animation-grid">
        {shown.map((p) => (
          <a
            className="animation-card"
            data-testid="project-card"
            key={p.id}
            href={"#/film/" + p.id}
          >
            <div className="card-art" style={{ background: p.accent }}>
              <img src={assetUrl(p.poster)} alt={p.title + " 实际动画画面"} />
              <span className="card-type">
                {p.renderer === "three"
                  ? "3D / THREE.JS"
                  : p.renderer === "pixi"
                    ? "2D / PIXIJS"
                    : "VECTOR / CANVAS"}
              </span>
              <span className="card-duration">{formatTime(p.duration)}</span>
              <span className="card-play">
                <Play size={24} fill="currentColor" />
              </span>
            </div>
            <div className="card-content">
              <div className="card-title">
                <h3>{p.title}</h3>
                <ArrowUpRight size={18} />
              </div>
              <p>{p.subtitle}</p>
              <div className="card-meta">
                <span>{p.tags[0]}</span>
                <span>
                  {p.fps} FPS <b>·</b> 16:9
                </span>
              </div>
            </div>
          </a>
        ))}
      </div>
      {!shown.length && <div className="empty-state">没有符合条件的作品。</div>}
      <div className="studio-note">
        <span className="note-icon">
          <Clapperboard size={21} />
        </span>
        <div>
          <strong>这不是三份孤立的 Demo，而是同一套制作流程。</strong>
          <p>
            共用播放器、逐帧时间轴、中文字幕与导出工具。新故事只需要关心自己的素材和镜头。
          </p>
        </div>
        <a href="#/guide">
          查看制作约定 <ArrowRight size={16} />
        </a>
      </div>
    </div>
  );
}
interface Asset {
  name: string;
  url: string;
  type: "image" | "audio" | "video" | "model" | "soundfont" | "font" | "midi";
  bytes: number;
  license: string;
}
function AssetLibrary() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    fetch(assetUrl("assets.json"))
      .then((r) => {
        if (!r.ok) throw new Error("素材索引载入失败");
        return r.json();
      })
      .then(setAssets)
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <div className="library-page">
      <header className="library-heading">
        <div>
          <span className="eyebrow">ASSET LIBRARY</span>
          <h1>每个镜头的原材料。</h1>
          <p>素材与音轨随项目保存，不依赖运行时外链。</p>
        </div>
        <span className="outline-badge">
          <FolderOpen size={15} /> 项目素材
        </span>
      </header>
      <div className="asset-notice">
        <Terminal size={19} />
        <div>
          <strong>导入并优化本地素材</strong>
          <p>
            运行 <code>pnpm assets:import 项目id "素材的完整路径"</code>
            ，文件将复制到 该项目的 public/imports/
            并更新项目索引。源文件保持不变。
          </p>
        </div>
      </div>
      <div className="filter-tabs asset-filters">
        {[
          ["all", "全部素材"],
          ["image", "插画与图像"],
          ["audio", "音乐与音效"],
          ["soundfont", "乐器采样"],
          ["midi", "MIDI 乐谱"],
          ["font", "字体"],
          ["model", "3D 模型"],
          ["video", "视频"],
        ].map(([k, label]) => (
          <button
            className={filter === k ? "active" : ""}
            key={k}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="asset-grid">
        {assets
          .filter((a) => filter === "all" || a.type === filter)
          .map((a) => (
            <article className="asset-card" key={a.url}>
              <div className={"asset-preview " + a.type}>
                {a.type === "image" ? (
                  <img src={assetUrl(a.url)} alt={a.name} />
                ) : a.type === "audio" ? (
                  <>
                    <Music2 size={34} />
                    <audio controls preload="metadata" src={assetUrl(a.url)} />
                  </>
                ) : a.type === "soundfont" ? (
                  <Music2 size={34} />
                ) : a.type === "video" ? (
                  <video controls preload="metadata" src={assetUrl(a.url)} />
                ) : (
                  <Boxes size={42} />
                )}
              </div>
              <div className="asset-info">
                <strong title={a.name}>{a.name}</strong>
                <span>
                  {(a.bytes / 1024).toFixed(0)} KB <b>·</b>{" "}
                  {a.type.toUpperCase()}
                </span>
                <small>{a.license}</small>
                <a
                  href={assetUrl(a.url)}
                  download
                  className="asset-download"
                  aria-label={"下载 " + a.name}
                >
                  <Download size={16} />
                </a>
              </div>
            </article>
          ))}
      </div>
    </div>
  );
}
function Guide() {
  return (
    <div className="library-page guide-page">
      <header className="library-heading">
        <div>
          <span className="eyebrow">THE PRODUCTION PLAYBOOK</span>
          <h1>把下一个故事，放进来。</h1>
          <p>
            代码驱动制作，浏览器实时预览。以后所有动画，都在这个项目里持续积累。
          </p>
        </div>
        <BookOpen size={38} strokeWidth={1} />
      </header>
      <div className="guide-intro">
        <h2>工具负责稳定，创作负责好看。</h2>
        <p>
          这套工作台解决依赖、时间轴、播放、素材和输出问题。成片质量仍要靠分镜、角色表演、美术素材、镜头与声音设计。先做好一段短样片，再扩展为完整影片。
        </p>
      </div>
      <div className="guide-grid">
        <section>
          <span className="step-number">01</span>
          <h3>建立动画项目</h3>
          <p>一部动画一个目录。自动加入作品库，不需要修改播放器。</p>
          <pre>pnpm film new my-film "我的动画" --renderer pixi</pre>
          <p className="muted">
            renderer 可选 pixi、three、canvas。编辑生成的 project.ts 与
            scene.ts。
          </p>
        </section>
        <section>
          <span className="step-number">02</span>
          <h3>准备真正的素材</h3>
          <p>
            将分层插画、角色、音轨、模型导入自己的项目目录，记录来源和授权。
          </p>
          <pre>pnpm film import my-film "D:/assets/character.png"</pre>
          <p className="muted">
            图像可优化为 WebP；模型推荐 GLB；音频支持多音轨和浏览器实时生成。
          </p>
        </section>
        <section>
          <span className="step-number">03</span>
          <h3>只接一根主时间轴</h3>
          <p>
            场景实现
            render(time)。所有位置、形变、镜头和骨骼动作，都由绝对时间决定。
          </p>
          <pre>
            {
              "render(time) {\n  timeline.seek(time, true);\n  renderer.render(scene, camera);\n}"
            }
          </pre>
          <p className="muted">
            不要创建自己的 requestAnimationFrame、setInterval 或独立音乐计时器。
          </p>
        </section>
        <section>
          <span className="step-number">04</span>
          <h3>验证，再导出</h3>
          <p>检查反向拖动、暂停、字幕和音频，使用逐帧渲染输出正式视频。</p>
          <pre>
            {
              "pnpm film check my-film --strict\npnpm film storyboard my-film\npnpm film render my-film --width 1920"
            }
          </pre>
          <p className="muted">
            逐帧 MP4 不依赖实时帧率，输出包含完整混音与可选字幕。
          </p>
        </section>
      </div>
      <div className="guide-bottom">
        <section>
          <h3>
            <Boxes size={20} /> 已接入的制作工具
          </h3>
          <div className="tool-stack">
            {[
              ["PixiJS", "分层图像、精灵、蒙版与二维场景"],
              ["Three.js", "模型、材质、灯光、骨骼与摄影机"],
              ["GSAP + Flubber", "精确时间轴与矢量形变"],
              ["Web Audio", "多音轨、实时生成声音与同步混音"],
              ["Playwright + FFmpeg", "逐帧截图、MP4 与浏览器验收"],
              ["Sharp + SVGO", "图像与矢量素材优化"],
            ].map(([name, desc]) => (
              <div key={name}>
                <CheckCircle2 size={16} />
                <strong>{name}</strong>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>
            <Cpu size={20} /> 项目结构
          </h3>
          <pre>
            {
              "projects/<id>/  仅修改自己的项目文件夹\n  project.ts   元数据\n  scene.ts     场景\n  audio.ts     可选实时声音\n  public/      素材、配乐与封面\n  production/  原始材料与许可\n  scripts/     项目工具\n  tests/       项目测试\n  exports/     视频与单帧输出\nsrc/engine/    公共引擎（只读使用）"
            }
          </pre>
          <p>详细说明见项目 README.md 与 docs/AUTHORING.md。</p>
        </section>
      </div>
      <div className="quality-note">
        <ImageIcon size={22} />
        <p>
          <strong>验收时，先关闭字幕。</strong>{" "}
          如果画面本身说不清发生了什么，就继续调整分镜与动作，而不是增加说明文字。
        </p>
      </div>
    </div>
  );
}
