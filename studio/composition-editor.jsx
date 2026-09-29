import { useEffect, useRef, useState } from "react";
import {
  Layers,
  Plus,
  Undo2,
  Redo2,
  RefreshCw,
  Scissors,
  Trash2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { api, Button, ErrorNote, Loading } from "./ui";
import {
  editVisualDocument,
  clipTime,
  sampleValue,
} from "../src/engine/visual-document.mjs";
import "./composition-editor.css";
const number = (value) => Number(value);
const sourceLabel = (clip) => clip.source.engine ?? clip.source.kind;
export function CompositionEditor({
  work,
  visible,
  position,
  onSeek,
  onSaved,
  disabled = false,
}) {
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(""),
    [files, setFiles] = useState([]),
    [asset, setAsset] = useState(""),
    [kind, setKind] = useState("image");
  const [zoom, setZoom] = useState(1),
    [draft, setDraft] = useState(null),
    [undo, setUndo] = useState([]),
    [redo, setRedo] = useState([]),
    [keyProperty, setKeyProperty] = useState("opacity"),
    [jsonDraft, setJsonDraft] = useState(null);
  const lock = useRef(false),
    drag = useRef(null),
    timeline = useRef(null),
    current = useRef(null);
  current.current = state;
  const load = async () => {
    setError("");
    try {
      const [data, entries] = await Promise.all([
        api("works_composition", { id: work.id }),
        api("works_files", { id: work.id }),
      ]);
      current.current = data;
      setState(data);
      setFiles(entries);
      setUndo([]);
      setRedo([]);
      setDraft(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    setState(null);
    setSelected("");
    setDraft(null);
    setUndo([]);
    setRedo([]);
  }, [work.id]);
  useEffect(() => {
    if (visible && !state) void load();
  }, [visible, work.id, state]);
  useEffect(() => {
    setDraft(null);
    setJsonDraft(null);
  }, [selected]);
  const apply = async (operations, { history = true } = {}) => {
    if (lock.current || disabled || !current.current?.document) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    const before = current.current;
    try {
      editVisualDocument(before.document, operations, {
        projectId: work.project,
        duration: before.duration,
      });
      const next = await api("works_composition_edit", {
        id: work.id,
        expectedSha256: before.sha256,
        operations,
      });
      current.current = next;
      setState(next);
      setDraft(null);
      setJsonDraft(null);
      if (history) {
        setUndo((list) => [...list.slice(-29), before.document]);
        setRedo([]);
      }
      onSaved?.();
      return true;
    } catch (e) {
      setError(e.message + "。如有版本冲突，请刷新后重新操作。");
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const history = async (back) => {
    const stack = back ? undo : redo,
      document = stack.at(-1);
    if (!document) return;
    const before = state.document;
    if (await apply([{ op: "replace", document }], { history: false })) {
      (back ? setUndo : setRedo)((list) => list.slice(0, -1));
      (back ? setRedo : setUndo)((list) => [...list, before]);
    }
  };
  if (!state)
    return (
      <>
        <ErrorNote error={error} />
        <Loading />
        <Button onClick={load}>重新读取</Button>
      </>
    );
  if (!state.document)
    return (
      <div className="composition-empty">
        <Layers />
        <h3>此作品使用程序化场景</h3>
        <p>
          当前画面由 scene.ts 生成。AI
          可以把它接入合成文档，保留现有场景并叠加其他素材。
        </p>
        <details>
          <summary>可用引擎与素材源</summary>
          {state.adapters.map((a) => (
            <p key={a.id}>
              {a.name} · {a.category}
            </p>
          ))}
        </details>
      </div>
    );
  const clips = state.document.clips,
    clip = clips.find((c) => c.id === selected),
    form = draft ?? clip;
  const change = (key, value) => {
    setJsonDraft(null);
    setDraft({ ...form, [key]: value });
  };
  const transform = (key, value) =>
    change("transform", { ...form.transform, [key]: number(value) });
  const split = () =>
    clip &&
    apply([
      {
        op: "split",
        id: clip.id,
        at: Math.round((position?.time ?? 0) * state.fps) / state.fps,
        newId: "clip_" + crypto.randomUUID().slice(0, 8),
      },
    ]);
  const begin = (event, c, mode) => {
    if (busy || disabled || event.button !== 0) return;
    event.preventDefault();
    setSelected(c.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      clip: c,
      mode,
      target: event.currentTarget,
      patch: null,
    };
  };
  const move = (event) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    const width =
      timeline.current
        ?.querySelector(".composition-lane")
        ?.getBoundingClientRect().width || 1;
    let delta =
      Math.round(((event.clientX - d.x) / width) * state.duration * state.fps) /
      state.fps;
    const c = d.clip,
      min = 1 / state.fps;
    if (d.mode === "move")
      d.patch = {
        start: Math.max(
          0,
          Math.min(state.duration - c.duration, c.start + delta),
        ),
      };
    if (d.mode === "end")
      d.patch = {
        duration: Math.max(
          min,
          Math.min(state.duration - c.start, c.duration + delta),
        ),
      };
    if (d.mode === "start") {
      delta = Math.max(
        -c.start,
        -((c.offset ?? 0) + (c.phase ?? 0)) / c.rate,
        Math.min(c.duration - min, delta),
      );
      const mapped = (c.offset ?? 0) + (c.phase ?? 0) + delta * c.rate;
      d.patch = {
        start: c.start + delta,
        duration: c.duration - delta,
        offset: c.loop ? c.offset : mapped,
        phase: c.loop
          ? ((((c.phase ?? 0) + delta * c.rate) % c.loop) + c.loop) % c.loop
          : 0,
        fadeOffset: Math.max(0, (c.fadeOffset ?? 0) + delta),
        fadeDuration: c.fadeDuration ?? c.duration,
      };
    }
    setDraft({ ...c, ...d.patch });
  };
  const end = async (event) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (d.target.hasPointerCapture(event.pointerId))
      d.target.releasePointerCapture(event.pointerId);
    if (d.patch) await apply([{ op: "update", id: d.clip.id, patch: d.patch }]);
    else onSeek?.(d.clip.start);
  };
  const add = async () => {
    const id = "clip_" + crypto.randomUUID().slice(0, 8),
      start = Math.min(position?.time ?? 0, state.duration - 1 / state.fps);
    const source =
      kind === "color"
        ? { kind, color: "#607de8" }
        : { kind, src: "films/" + work.project + "/" + asset.slice(7) };
    if (!["color"].includes(kind) && !asset) {
      setError("请选择本作品中的素材");
      return;
    }
    try {
      const metadata =
        kind === "color"
          ? null
          : await api("works_media_probe", { id: work.id, src: source.src });
      if (
        await apply([
          {
            op: "add",
            clip: {
              id,
              name: kind === "color" ? "色块" : asset.split("/").at(-1),
              source,
              start,
              duration: Math.min(
                metadata?.duration ?? 5,
                state.duration - start,
              ),
              ...(metadata?.hasAudio
                ? { audio: { enabled: true, gain: 1 } }
                : {}),
            },
          },
        ])
      )
        setSelected(id);
    } catch (e) {
      setError(e.message);
    }
  };
  const allowed = files.filter(
    (f) =>
      f.path?.startsWith("public/") &&
      (kind === "image"
        ? /\.(png|jpg|jpeg|webp|svg|avif)$/i.test(f.path)
        : kind === "video"
          ? /\.(mp4|webm|mov)$/i.test(f.path)
          : kind === "lottie"
            ? /\.json$/i.test(f.path) &&
              !/(assets|waveforms)\.json$/.test(f.path)
            : false),
  );
  return (
    <section className="composition-editor" aria-label="混合合成编辑器">
      <div className="composition-actions">
        <Button
          icon={Undo2}
          aria-label="撤销合成修改"
          disabled={busy || disabled || !undo.length}
          onClick={() => history(true)}
        />
        <Button
          icon={Redo2}
          aria-label="重做合成修改"
          disabled={busy || disabled || !redo.length}
          onClick={() => history(false)}
        />
        <Button icon={RefreshCw} disabled={busy} onClick={load}>
          刷新
        </Button>
        <label>
          缩放
          <input
            aria-label="合成时间轴缩放"
            type="range"
            min="1"
            max="8"
            step=".25"
            value={zoom}
            onChange={(e) => setZoom(number(e.target.value))}
          />
        </label>
      </div>
      <ErrorNote error={error} />
      <p className="quiet" role="status">
        {busy ? "正在保存…" : "从下到上叠加画面；拖动片段移动，拖动两端裁切。"}
        {disabled ? " · 正在导出，编辑暂不可用" : ""}
      </p>
      <div className="composition-timeline" ref={timeline}>
        <div style={{ minWidth: Math.max(400, 400 * zoom) }}>
          <div className="composition-ruler">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} style={{ left: i * 20 + "%" }}>
                {((state.duration * i) / 5).toFixed(1)}s
              </span>
            ))}
          </div>
          {clips.toReversed().map((c) => {
            const shown = drag.current?.clip.id === c.id && draft ? draft : c;
            return (
              <div className="composition-row" key={c.id}>
                <button
                  className="composition-label"
                  onClick={() => setSelected(c.id)}
                  title={c.name ?? c.id}
                >
                  {c.name ?? c.id}
                  <small>{sourceLabel(c)}</small>
                </button>
                <div
                  className="composition-lane"
                  onDoubleClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onSeek?.(((e.clientX - r.left) / r.width) * state.duration);
                  }}
                >
                  <button
                    className={
                      "composition-clip " +
                      (selected === c.id ? "selected" : "")
                    }
                    aria-label={"选择片段 " + (c.name ?? c.id)}
                    style={{
                      left: (shown.start / state.duration) * 100 + "%",
                      width: (shown.duration / state.duration) * 100 + "%",
                      opacity: c.hidden ? 0.4 : 1,
                    }}
                    disabled={busy || disabled}
                    onClick={() => setSelected(c.id)}
                    onPointerDown={(e) => begin(e, c, "move")}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={() => {
                      drag.current = null;
                      setDraft(null);
                    }}
                  >
                    <i
                      aria-label="片段入点"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        begin(e, c, "start");
                      }}
                    />
                    <span>{c.name ?? c.id}</span>
                    <i
                      aria-label="片段出点"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        begin(e, c, "end");
                      }}
                    />
                  </button>
                  <b
                    className="composition-playhead"
                    style={{
                      left:
                        Math.min(1, (position?.time ?? 0) / state.duration) *
                          100 +
                        "%",
                    }}
                  />
                </div>
              </div>
            );
          })}
          {!clips.length && (
            <p className="composition-empty">
              空白项目。添加素材，或让 AI 选择合适的引擎开始创作。
            </p>
          )}
        </div>
      </div>
      <div className="composition-add">
        <select
          aria-label="新增图层类型"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setAsset("");
          }}
        >
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="lottie">Lottie</option>
          <option value="color">色块</option>
        </select>
        {kind !== "color" && (
          <select
            aria-label="选择作品素材"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
          >
            <option value="">选择已导入的素材</option>
            {allowed.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path.slice(7)}
              </option>
            ))}
          </select>
        )}
        <Button icon={Plus} disabled={busy || disabled} onClick={add}>
          添加
        </Button>
      </div>
      {clip && form && (
        <form
          className="composition-inspector"
          onSubmit={(e) => {
            e.preventDefault();
            let value = form;
            if (jsonDraft !== null) {
              try {
                value = JSON.parse(jsonDraft);
                if (value.id !== selected) throw Error();
              } catch {
                setError("结构化属性必须是有效 JSON 且保留片段 id");
                return;
              }
            }
            const { id, ...patch } = value;
            const unset = Object.keys(clip).filter(
              (k) => k !== "id" && value[k] === undefined,
            );
            void apply([{ op: "update", id, patch, unset }]);
          }}
        >
          <div className="composition-actions">
            <strong>片段属性</strong>
            <Button
              type="button"
              icon={Scissors}
              disabled={
                busy ||
                disabled ||
                !(
                  position?.time > clip.start &&
                  position.time < clip.start + clip.duration
                )
              }
              onClick={split}
            >
              分割
            </Button>
            <Button
              type="button"
              icon={ArrowUp}
              aria-label="上移图层"
              disabled={
                busy || disabled || clips.indexOf(clip) === clips.length - 1
              }
              onClick={() =>
                apply([
                  {
                    op: "reorder",
                    id: clip.id,
                    index: clips.indexOf(clip) + 1,
                  },
                ])
              }
            />
            <Button
              type="button"
              icon={ArrowDown}
              aria-label="下移图层"
              disabled={busy || disabled || clips.indexOf(clip) === 0}
              onClick={() =>
                apply([
                  {
                    op: "reorder",
                    id: clip.id,
                    index: clips.indexOf(clip) - 1,
                  },
                ])
              }
            />
            <Button
              type="button"
              icon={Trash2}
              aria-label="删除片段"
              disabled={busy || disabled}
              onClick={() => apply([{ op: "remove", id: clip.id }])}
            />
          </div>
          <label>
            名称
            <input
              value={form.name ?? form.id}
              onChange={(e) => change("name", e.target.value)}
            />
          </label>
          <div className="composition-grid">
            {[
              ["start", "影片起点"],
              ["duration", "持续秒数"],
              ["offset", "素材入点"],
              ["rate", "素材速度"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  step={key === "rate" ? 0.05 : 1 / state.fps}
                  min={
                    key === "duration"
                      ? 1 / state.fps
                      : key === "rate"
                        ? 0.05
                        : 0
                  }
                  value={form[key]}
                  onChange={(e) => change(key, number(e.target.value))}
                />
              </label>
            ))}
          </div>
          {form.source.src && (
            <label>
              替换素材
              <select
                aria-label="替换片段素材"
                value={form.source.src}
                onChange={(e) =>
                  change("source", { ...form.source, src: e.target.value })
                }
              >
                <option value={form.source.src}>
                  {form.source.src.split("/").at(-1)}
                </option>
                {files
                  .filter(
                    (f) =>
                      f.path?.startsWith("public/") &&
                      (form.source.kind === "video"
                        ? /\.(mp4|webm)$/i
                        : form.source.kind === "lottie"
                          ? /\.json$/i
                          : /\.(png|jpg|jpeg|webp|svg|avif)$/i
                      ).test(f.path),
                  )
                  .map((f) => (
                    <option
                      key={f.path}
                      value={"films/" + work.project + "/" + f.path.slice(7)}
                    >
                      {f.path.slice(7)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            循环素材秒数（0 为关闭）
            <input
              aria-label="循环素材秒数"
              type="number"
              min="0"
              step={1 / state.fps}
              value={form.loop ?? 0}
              onChange={(e) =>
                change("loop", Number(e.target.value) || undefined)
              }
            />
          </label>
          <details>
            <summary>素材裁切</summary>
            <div className="composition-grid">
              {["x", "y", "width", "height"].map((k) => (
                <label key={k}>
                  {k}
                  <input
                    aria-label={"裁切 " + k}
                    type="number"
                    min="0"
                    max="1"
                    step=".01"
                    value={
                      form.crop?.[k] ??
                      (["width", "height"].includes(k) ? 1 : 0)
                    }
                    onChange={(e) =>
                      change("crop", {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        ...form.crop,
                        [k]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </details>
          <details open>
            <summary>位置与合成</summary>
            <div className="composition-grid">
              {["x", "y", "width", "height", "rotation", "opacity"].map(
                (key, i) => (
                  <label key={key}>
                    {
                      [
                        "横向位置",
                        "纵向位置",
                        "宽度比例",
                        "高度比例",
                        "旋转角度",
                        "透明度",
                      ][i]
                    }
                    {Array.isArray(form.transform?.[key]) ? (
                      <small>已配置关键帧</small>
                    ) : (
                      <input
                        type="number"
                        step=".01"
                        value={
                          form.transform?.[key] ??
                          (["width", "height", "opacity"].includes(key) ? 1 : 0)
                        }
                        onChange={(e) => transform(key, e.target.value)}
                      />
                    )}
                  </label>
                ),
              )}
              <label>
                适配
                <select
                  value={form.fit}
                  onChange={(e) => change("fit", e.target.value)}
                >
                  {["contain", "cover", "fill"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                混合
                <select
                  value={form.blend}
                  onChange={(e) => change("blend", e.target.value)}
                >
                  {[
                    "source-over",
                    "multiply",
                    "screen",
                    "overlay",
                    "darken",
                    "lighten",
                    "difference",
                    "destination-in",
                    "destination-out",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {["fadeIn", "fadeOut"].map((key, i) => (
                <label key={key}>
                  {i ? "淡出秒数" : "淡入秒数"}
                  <input
                    type="number"
                    min="0"
                    step=".05"
                    value={form[key] ?? 0}
                    onChange={(e) => change(key, number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          </details>
          {form.source.kind === "video" && (
            <fieldset>
              <legend>视频原声</legend>
              <label>
                <input
                  type="checkbox"
                  checked={!!form.audio?.enabled}
                  onChange={(e) =>
                    change("audio", {
                      ...form.audio,
                      enabled: e.target.checked,
                    })
                  }
                />
                随片段裁切、变速和循环
              </label>
              <label>
                音量
                <input
                  type="number"
                  min="0"
                  max="4"
                  step=".1"
                  value={form.audio?.gain ?? 1}
                  onChange={(e) =>
                    change("audio", {
                      ...form.audio,
                      enabled: !!form.audio?.enabled,
                      gain: number(e.target.value),
                    })
                  }
                />
              </label>
            </fieldset>
          )}
          <details>
            <summary>关键帧</summary>
            <select
              aria-label="关键帧属性"
              value={keyProperty}
              onChange={(e) => setKeyProperty(e.target.value)}
            >
              {["x", "y", "width", "height", "rotation", "opacity"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <Button
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                const at = Math.max(
                  0,
                  clipTime(form, position?.time ?? form.start) ?? form.offset,
                );
                const old = form.transform?.[keyProperty],
                  keys = Array.isArray(old) ? old : [],
                  value = sampleValue(
                    old,
                    at,
                    ["opacity", "width", "height"].includes(keyProperty)
                      ? 1
                      : 0,
                  );
                change("transform", {
                  ...form.transform,
                  [keyProperty]: [
                    ...keys.filter((k) => Math.abs(k.at - at) > 1e-5),
                    { at, value, easing: "smooth" },
                  ].sort((a, b) => a.at - b.at),
                });
              }}
            >
              在当前时间添加
            </Button>
            {(Array.isArray(form.transform?.[keyProperty])
              ? form.transform[keyProperty]
              : []
            ).map((key, index) => (
              <div className="composition-key" key={index}>
                <input
                  aria-label={"关键帧时间 " + index}
                  type="number"
                  min="0"
                  step={1 / state.fps}
                  value={key.at}
                  onChange={(e) =>
                    change("transform", {
                      ...form.transform,
                      [keyProperty]: form.transform[keyProperty].map((k, i) =>
                        i === index ? { ...k, at: Number(e.target.value) } : k,
                      ),
                    })
                  }
                />
                <input
                  aria-label={"关键帧数值 " + index}
                  type="number"
                  step=".01"
                  value={key.value}
                  onChange={(e) =>
                    change("transform", {
                      ...form.transform,
                      [keyProperty]: form.transform[keyProperty].map((k, i) =>
                        i === index
                          ? { ...k, value: Number(e.target.value) }
                          : k,
                      ),
                    })
                  }
                />
                <select
                  aria-label={"插值 " + index}
                  value={key.easing ?? "linear"}
                  onChange={(e) =>
                    change("transform", {
                      ...form.transform,
                      [keyProperty]: form.transform[keyProperty].map((k, i) =>
                        i === index ? { ...k, easing: e.target.value } : k,
                      ),
                    })
                  }
                >
                  <option value="linear">线性</option>
                  <option value="smooth">缓入缓出</option>
                  <option value="hold">保持</option>
                </select>
                <Button
                  type="button"
                  aria-label={"删除关键帧 " + index}
                  onClick={() => {
                    const keys = form.transform[keyProperty].filter(
                      (_, i) => i !== index,
                    );
                    change("transform", {
                      ...form.transform,
                      [keyProperty]: keys.length ? keys : key.value,
                    });
                  }}
                >
                  ×
                </Button>
              </div>
            ))}
          </details>
          <details>
            <summary>素材、裁切与场景参数</summary>
            <p className="quiet">
              坐标为画幅比例；关键帧 at 使用素材秒数。保留未修改字段。
            </p>
            <textarea
              aria-label="片段结构化属性"
              key={selected + state.sha256}
              rows="9"
              value={jsonDraft ?? JSON.stringify(form, null, 2)}
              onChange={(e) => {
                setJsonDraft(e.target.value);
                try {
                  const value = JSON.parse(e.target.value);
                  if (value.id !== selected) throw Error("不能修改片段 id");
                  setDraft(value);
                  setError("");
                } catch (e) {
                  setError(e.message);
                }
              }}
            />
          </details>
          <div className="composition-actions">
            <label>
              <input
                type="checkbox"
                checked={!!form.hidden}
                onChange={(e) => change("hidden", e.target.checked)}
              />
              隐藏
            </label>
            <Button type="submit" disabled={busy || disabled || !draft}>
              保存属性
            </Button>
            {draft && (
              <Button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setJsonDraft(null);
                }}
              >
                放弃修改
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
