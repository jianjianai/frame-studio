import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, FileCode2, Music, Pause, Play, RotateCcw, Sparkles, Square, AudioLines } from "lucide-react";
import { api, workPath, useServerEvent } from "../lib/api";
import { useToast } from "../lib/ui";
import { useWorkbench } from "./store";
import { assetDrag } from "./assetDrag";
import { seconds, soundAsset } from "../views/ResourcesPanel";

/** What src/preview/resource.ts exposes (same origin). */
interface ResourceInfo {
  key: string;
  kind: string;
  title: string;
  description?: string;
  usage?: string;
  width: number;
  height: number;
  duration: number;
  time: number;
  background: string;
  schema: { properties?: Record<string, JsonSchema> } | null;
  presets: Record<string, Record<string, unknown>>;
  defaults: Record<string, unknown>;
}
interface SoundInfo {
  key: string;
  title: string;
  duration: number;
  hit?: number;
  description?: string;
}
interface PageApi {
  ready: boolean;
  error?: string;
  resources: ResourceInfo[];
  sounds: SoundInfo[];
  show(key: string, options: { preset?: string; values?: Record<string, unknown>; time?: number }): Promise<void>;
  showSound(key: string): Promise<void>;
  play(key: string): Promise<number>;
  stop(): void;
}
interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  description?: string;
  title?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
}

const KIND_LABELS: Record<string, string> = { character: "角色", prop: "物品", set: "场景", ui: "界面", effect: "效果", transition: "转场", text: "文字" };

/**
 * A resource of the material libraries in an editor tab: drawn by the library's own code as
 * the library has it now (with the work's tempo), with its parameters as controls, its presets,
 * and a time slider for animated ones. A sound module shows its sounds: listen, see the
 * waveform, drag onto an audio track.
 */
export function ResourceViewer({ id }: { id: string }) {
  const { work, readOnly, openMaterial, addToChat, stage, reload } = useWorkbench();
  const toast = useToast();
  const [ref, key] = id.split("#");
  const [stamp, setStamp] = useState(() => Date.now());
  const frame = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState<PageApi | null>(null);
  const [failure, setFailure] = useState("");
  const [preset, setPreset] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState(key);
  const linked = (work.meta?.materials ?? []).includes(ref.split("/")[0]);
  const tempo = JSON.stringify(work.meta?.tempo ?? null);

  const src = `/preview/resource.html?${new URLSearchParams({
    material: ref,
    ...work.preview.library,
    tempo,
    stamp: String(stamp),
  })}`;

  // The page loads the library module; wait until it says it is ready (or why not).
  const attach = useCallback(() => {
    setPage(null);
    setFailure("");
    const started = Date.now();
    const timer = setInterval(() => {
      const found = (frame.current?.contentWindow as unknown as { __FRAME_RESOURCE__?: PageApi } | null)?.__FRAME_RESOURCE__;
      if (found?.ready) {
        clearInterval(timer);
        setPage(found);
      } else if (found?.error) {
        clearInterval(timer);
        setFailure(found.error);
      } else if (Date.now() - started > 60000) {
        clearInterval(timer);
        setFailure("加载超时");
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => page?.stop(), [page]);

  // Library code changed: load the page anew.
  useServerEvent(
    (event) => {
      if (event.type === "materials" && event.repo === work.repo) setStamp(Date.now());
    },
    [work.repo],
  );

  const info = page?.resources.find((item) => item.key === key) ?? null;
  const sounds = page?.sounds ?? [];
  const isSound = Boolean(page && !info && sounds.length);

  // Draw whenever something changes.
  useEffect(() => {
    if (!page || !info) return;
    let current = true;
    page
      .show(key, { preset: preset || undefined, values, time: time ?? info.time })
      .then(
        () => current && setFailure(""),
        (error: Error) => current && setFailure(error.message),
      );
    return () => {
      current = false;
    };
  }, [page, info, key, preset, values, time]);
  useEffect(() => {
    if (page && isSound && sound) void page.showSound(sound).catch((error: Error) => setFailure(error.message));
  }, [page, isSound, sound]);

  // Play an animated resource: time runs in real time and loops.
  useEffect(() => {
    if (!playing || !info?.duration) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((value) => ((value ?? info.time) + (now - last) / 1000) % info.duration);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, info]);

  const effective = (name: string) => (name in values ? values[name] : preset && name in (info?.presets[preset] ?? {}) ? info!.presets[preset][name] : info?.defaults[name]);
  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));
  const changed = { ...(preset ? info?.presets[preset] : {}), ...values };

  const copy = () => {
    const lines = [`// ${info?.title}（${id}）`, `import { … } from "@materials/${ref.replace(/\.(m?[jt]sx?)$/, "")}";`];
    if (info?.usage) lines.push(`// 用法：${info.usage}`);
    if (Object.keys(changed).length) lines.push(`const params = ${JSON.stringify(changed, null, 2)};`);
    void navigator.clipboard.writeText(lines.join("\n")).then(() => toast("已复制导入语句、用法和当前参数"));
  };
  const placeSound = (item: SoundInfo) =>
    api(`${workPath(work.repo, work.id)}/audio/place`, { body: { sound: `${ref}#${item.key}`, start: stage.playback.get().time, track: "音效", name: item.title } }).then(
      () => (toast(`已把「${item.title}」放到「音效」音轨`, "ok"), reload()),
      (error: Error) => toast(error.message, "error"),
    );

  return (
    <div className="resource-viewer">
      <div className="editor-toolbar material-toolbar">
        <span className="ellipsis grow small-text" title={id}>
          <strong>{info?.title ?? (isSound ? sounds.find((item) => item.key === sound)?.title : key)}</strong>
          <span className="faint">
            {" "}
            · {info ? KIND_LABELS[info.kind] ?? info.kind : isSound ? "音效" : "资源"} · materials/{ref}
          </span>
        </span>
        {info && Object.keys(info.presets).length > 0 && (
          <select
            className="input small"
            value={preset}
            onChange={(event) => {
              setPreset(event.target.value);
              setValues({});
            }}
            title="预设"
          >
            <option value="">默认参数</option>
            {Object.keys(info.presets).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {info && (
          <button className="btn small" onClick={() => (setValues({}), setPreset(""))} title="恢复默认参数">
            <RotateCcw size={13} />
          </button>
        )}
        {info && (
          <button className="btn small" onClick={copy} title="复制导入语句、用法和当前参数">
            <Copy size={13} /> 复制代码
          </button>
        )}
        <button className="btn small" onClick={() => addToChat({ type: "resource", id: isSound ? `${ref}#${sound}` : id, title: info?.title })}>
          <Sparkles size={13} /> 引用到 AI 聊天
        </button>
        <button className="btn small" onClick={() => openMaterial(ref)} title="在素材库里查看这个文件的代码">
          <FileCode2 size={13} /> 源码
        </button>
      </div>
      {info?.description && <div className="material-state faint">{info.description}</div>}
      <div className="resource-body">
        <div className="resource-stage">
          <iframe
            key={src}
            ref={frame}
            src={src}
            title="资源预览"
            onLoad={attach}
            style={{ background: info?.background ? undefined : "transparent" }}
          />
          {failure && <div className="resource-error">{failure}</div>}
        </div>
        {info && (
          <div className="resource-controls">
            {info.duration > 0 && (
              <div className="resource-time">
                <button className="icon-btn" onClick={() => setPlaying(!playing)} title={playing ? "暂停" : "播放"}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={info.duration}
                  step={0.01}
                  value={time ?? info.time}
                  onChange={(event) => (setPlaying(false), setTime(Number(event.target.value)))}
                />
                <span className="mono small-text">{(time ?? info.time).toFixed(2)}s</span>
              </div>
            )}
            {Object.entries(info.schema?.properties ?? {}).map(([name, schema]) => (
              <Control key={name} name={name} schema={schema} value={effective(name)} changed={name in values} onChange={(value) => set(name, value)} />
            ))}
            {!Object.keys(info.schema?.properties ?? {}).length && <p className="faint small-text">这个资源没有可调的参数。</p>}
            {info.usage && (
              <div className="resource-usage">
                <div className="faint small-text">用法</div>
                <code>{info.usage}</code>
              </div>
            )}
          </div>
        )}
        {isSound && (
          <div className="resource-controls">
            <div className="faint small-text">
              {sounds.length} 个音效。单击试听，{linked && !readOnly ? "拖到时间轴的音轨上使用。" : readOnly ? "作品已发布，不能放到音轨。" : "引用这个素材库后可以拖到音轨。"}
            </div>
            <div className="sound-list">
              {sounds.map((item) => (
                <div
                  key={item.key}
                  className={`sound-row ${item.key === sound ? "active" : ""}`}
                  draggable={linked && !readOnly}
                  onDragStart={(event) => assetDrag.start(event, soundAsset({ id: `${ref}#${item.key}`, title: item.title, duration: item.duration, module: `materials/${ref}` }))}
                  onDragEnd={() => assetDrag.end()}
                  onClick={() => {
                    setSound(item.key);
                    void page!.play(item.key).catch((error: Error) => setFailure(error.message));
                  }}
                  title={`${item.key}${item.description ? "\n" + item.description : ""}`}
                >
                  <AudioLines size={13} />
                  <span className="ellipsis grow">{item.title}</span>
                  <span className="faint mono small-text">{item.key}</span>
                  <span className="faint small-text">{seconds(item.duration)}</span>
                  {linked && !readOnly && (
                    <button
                      className="icon-btn tiny"
                      title="放到「音效」音轨（播放头处）"
                      onClick={(event) => {
                        event.stopPropagation();
                        void placeSound(item);
                      }}
                    >
                      <Music size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="btn small" onClick={() => page?.stop()}>
              <Square size={12} /> 停止
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One parameter: a select for choices, a slider for ranges, a checkbox, or a text field. */
function Control({ name, schema, value, changed, onChange }: { name: string; schema: JsonSchema; value: unknown; changed: boolean; onChange: (value: unknown) => void }) {
  const options = schema.enum ?? schema.anyOf?.flatMap((item) => item.enum ?? []);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const min = schema.minimum ?? schema.exclusiveMinimum;
  const max = schema.maximum ?? schema.exclusiveMaximum;
  const label = (
    <span className={`resource-param-name ${changed ? "changed" : ""}`} title={schema.description}>
      {schema.title ?? name}
    </span>
  );
  let input;
  if (options?.length)
    input = (
      <select className="input small" value={JSON.stringify(value ?? null)} onChange={(event) => onChange(JSON.parse(event.target.value))}>
        {value === undefined && <option value="null">（未设置）</option>}
        {options.map((option) => (
          <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  else if (type === "boolean") input = <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
  else if (type === "number" || type === "integer")
    input =
      min !== undefined && max !== undefined ? (
        <span className="resource-range">
          <input type="range" min={min} max={max} step={type === "integer" ? 1 : (max - min) / 200} value={Number(value ?? min)} onChange={(event) => onChange(Number(event.target.value))} />
          <span className="mono small-text">{typeof value === "number" ? +value.toFixed(3) : "—"}</span>
        </span>
      ) : (
        <input className="input small" type="number" value={typeof value === "number" ? value : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />
      );
  else if (type === "string") input = <input className="input small" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  else input = <code className="small-text faint ellipsis">{JSON.stringify(value) ?? "—"}</code>;
  return (
    <label className="resource-param" title={schema.description}>
      {label}
      {input}
      {schema.description && <span className="resource-param-help faint">{schema.description}</span>}
    </label>
  );
}
