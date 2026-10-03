import { randomUUID } from "../src/browser/uuid.mjs";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Save,
  Undo2,
  Redo2,
  Trash2,
  Scissors,
  Music2,
  RefreshCw,
  Volume2,
  SlidersHorizontal,
} from "lucide-react";
import { api, Button, ErrorNote, Loading } from "./ui";
import {
  validateAudioDocument,
  audioProcessorSchema,
  audioProcessors,
  editAudioDocument,
} from "../src/engine/audio-document.mjs";
import "./audio-editor.css";
import { ToneEffectEditor, defaultToneOptions } from "./tone-effect-editor";
import {
  NumberInput,
  NumericDraftProvider,
  flushNumericPending,
} from "./editor-inputs";
import { stretchPreset, stretchMode } from "./editor-drafts.mjs";
const uid = (p) => p + "_" + randomUUID().slice(0, 8);
const labels = {
  gain: "增益",
  pan: "声像",
  frequency: "频率 Hz",
  q: "Q",
  mode: "滤波模式",
  threshold: "阈值 dB",
  knee: "拐点 dB",
  ratio: "压缩比",
  attack: "起音秒",
  release: "释放秒",
  ceiling: "上限 dB",
  time: "延迟秒",
  feedback: "反馈",
  mix: "湿声比例",
  seconds: "尾音秒",
  decay: "衰减",
  seed: "随机种子",
  drive: "驱动",
  width: "宽度",
  track: "触发轨道",
  amount: "避让后音量",
};
const ClipWaveform = memo(function ClipWaveform({ clip: c, info }) {
  if (!info) return null;
  const points = Array.from({ length: 96 }, (_, i) => {
    const t = (c.phase ?? 0) + (i / 95) * c.duration * c.rate,
      offset = c.offset + (c.loop ? t % c.loop : t),
      bin = Math.floor((offset / info.duration) * info.peaks.length);
    return Math.min(1, info.peaks[bin] ?? 0);
  });
  return (
    <svg
      className="audio-waveform"
      viewBox="0 0 96 40"
      preserveAspectRatio="none"
      aria-label="素材波形"
    >
      <path
        d={points.map((v, i) => `M${i},${20 - v * 18}v${v * 36}`).join(" ")}
      />
    </svg>
  );
});

export function AudioEditor({
  work,
  visible,
  position: playerPosition,
  onSeek,
  onSaved,
  onDirtyChange,
  disabled = false,
}) {
  const position =
    typeof playerPosition === "number"
      ? playerPosition
      : (playerPosition?.time ?? 0);
  const [state, setState] = useState(null),
    [doc, setDoc] = useState(null),
    [files, setFiles] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [numericDirty, setNumericDirty] = useState(false),
    [numericReset, setNumericReset] = useState(0);
  const [selected, setSelected] = useState({ kind: "master" }),
    [past, setPast] = useState([]),
    [future, setFuture] = useState([]),
    [zoom, setZoom] = useState(1),
    [waveforms, setWaveforms] = useState({}),
    [conversion, setConversion] = useState("wav");
  const [sourceKind, setSourceKind] = useState("file"),
    [sourceFile, setSourceFile] = useState(""),
    [module, setModule] = useState(""),
    [engine, setEngine] = useState("web-audio"),
    [sourceTrack, setSourceTrack] = useState("main"),
    [chosenSource, setChosenSource] = useState(""),
    [processor, setProcessor] = useState("filter");
  useEffect(() => {
    if (!visible || !doc) return;
    let cancelled = false;
    (async () => {
      for (const source of doc.sources.filter((s) => s.kind === "file")) {
        if (cancelled) return;
        try {
          const info = await api("works_audio_inspect", {
            id: work.id,
            src: source.src,
          });
          if (!cancelled) setWaveforms((v) => ({ ...v, [source.src]: info }));
        } catch {
          /* A missing waveform never hides an editable clip. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, work.id, state?.sha256]);
  const transcode = async () => {
    if (!sourceFile) return;
    setBusy(true);
    setError("");
    try {
      const src = "films/" + work.project + "/" + sourceFile.slice(7),
        out =
          "public/" +
          sourceFile.slice(7).replace(/\.[^.]+$/, "") +
          "-" +
          randomUUID().slice(0, 6) +
          "." +
          conversion;
      const r = await api("works_audio_transcode", { id: work.id, src, out });
      setFiles(await api("works_files", { id: work.id }));
      setSourceFile(r.path);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const sourcesById = useMemo(
    () => new Map(doc?.sources.map((source) => [source.id, source]) ?? []),
    [doc?.sources],
  );
  const clipsByTrack = useMemo(() => {
    const groups = new Map();
    for (const clip of doc?.clips ?? []) {
      if (!groups.has(clip.track)) groups.set(clip.track, []);
      groups.get(clip.track).push(clip);
    }
    return groups;
  }, [doc?.clips]);
  const drag = useRef(null),
    loadRequest = useRef(0),
    current = useRef(null),
    editorElement = useRef(null);
  current.current = doc;
  const canonicalDirty = useMemo(
    () => !!state && JSON.stringify(doc) !== JSON.stringify(state.document),
    [doc, state?.document],
  );
  const dirty = canonicalDirty || numericDirty;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const blocked = disabled || busy;
  const load = async (restoreDraft = false) => {
    const request = ++loadRequest.current;
    setBusy(true);
    setError("");
    try {
      const [s, f] = await Promise.all([
        api("works_audio", { id: work.id }),
        api("works_files", { id: work.id }),
      ]);
      if (request !== loadRequest.current) return;
      let draft;
      if (restoreDraft) {
        try {
          draft = JSON.parse(
            sessionStorage.getItem("frame-audio-draft:" + work.id) || "null",
          );
          if (draft)
            draft.document = validateAudioDocument(draft.document, {
              projectId: work.project,
              duration: s.duration,
            });
        } catch {
          draft = undefined;
        }
      }
      if (draft) {
        setState({
          ...s,
          sha256: draft.sha256,
          projectSha256: draft.projectSha256,
          workId: work.id,
        });
        setDoc(draft.document);
        if (s.sha256 !== draft.sha256)
          setError("已恢复本机草稿；服务器版本已变化，请核对后重新载入。");
      } else {
        setState({ ...s, workId: work.id });
        setDoc(s.document);
      }
      setFiles(f);
      setNumericReset((previous) => previous + 1);
      setNumericDirty(false);
      setPast([]);
      setFuture([]);
    } catch (e) {
      if (request === loadRequest.current) setError(e.message);
    } finally {
      if (request === loadRequest.current) setBusy(false);
    }
  };
  useEffect(() => {
    ++loadRequest.current;
    setState(null);
    setDoc(null);
    setPast([]);
    setFuture([]);
    setSelected({ kind: "master" });
    setNumericDirty(false);
  }, [work.id]);
  useEffect(() => {
    if (visible) void load(true);
  }, [visible, work.id]);
  useEffect(() => {
    if (!dirty) return;
    const fn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
  useEffect(() => {
    if (!state || state.workId !== work.id || !doc) return;
    try {
      const key = "frame-audio-draft:" + work.id;
      if (canonicalDirty)
        sessionStorage.setItem(
          key,
          JSON.stringify({
            document: doc,
            sha256: state.sha256,
            projectSha256: state.projectSha256,
          }),
        );
      else sessionStorage.removeItem(key);
    } catch {
      /* Editing remains usable when browser storage is unavailable. */
    }
  }, [doc, state, work.id, canonicalDirty]);
  const change = (fn) => {
    if (blocked) return;
    setPast((p) => [...p.slice(-49), structuredClone(current.current)]);
    setFuture([]);
    setDoc((d) => {
      const n = structuredClone(d);
      fn(n);
      return n;
    });
  };
  const undo = () => {
    if (!past.length || blocked) return;
    setFuture((f) => [structuredClone(doc), ...f]);
    setDoc(past.at(-1));
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length || blocked) return;
    setPast((p) => [...p, structuredClone(doc)]);
    setDoc(future[0]);
    setFuture((f) => f.slice(1));
  };
  const save = async () => {
    if (blocked || !flushNumericPending(editorElement.current)) return;
    const pendingJson = editorElement.current?.querySelector(
      '[data-json-dirty="true"]',
    );
    if (pendingJson) {
      setError("有尚未应用的 JSON 参数，请先应用或恢复参数，再保存混音。");
      pendingJson.querySelector("textarea")?.focus();
      return;
    }
    const latest = current.current;
    if (
      state.declared &&
      JSON.stringify(latest) === JSON.stringify(state.document)
    )
      return;
    setBusy(true);
    setError("");
    try {
      const document = validateAudioDocument(latest, {
        projectId: work.project,
        duration: state.duration,
      });
      const next = await api("works_audio_edit", {
        id: work.id,
        expectedSha256: state.sha256,
        projectSha256: state.projectSha256,
        operations: [{ op: "replace", document }],
      });
      setState({ ...next, workId: work.id });
      setDoc(next.document);
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const addTrack = () => {
    const id = uid("track");
    change((d) =>
      d.tracks.push({
        id,
        name: "音轨 " + (d.tracks.length + 1),
        gain: 1,
        pan: 0,
        muted: false,
        processors: [],
        output: "master",
        sends: [],
      }),
    );
    setSelected({ kind: "tracks", id });
  };
  const addSource = async () => {
    setError("");
    try {
      const id = uid("source");
      if (sourceKind === "file") {
        if (!sourceFile) throw Error("请选择已导入的音频或视频素材");
        const src =
          "films/" + work.project + "/" + sourceFile.replace(/^public\//, "");
        const probe = await api("works_audio_media_probe", {
          id: work.id,
          src,
        });
        if (!probe.hasAudio) throw Error("素材没有音频流");
        change((d) => d.sources.push({ id, kind: "file", src }));
        setChosenSource(id);
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(module))
          throw Error("模块名需对应 audio.ts 中的生成器注册表");
        change((d) =>
          d.sources.push({
            id,
            kind: "generated",
            module,
            trackId: sourceTrack,
            engine,
          }),
        );
        setChosenSource(id);
      }
    } catch (e) {
      setError(e.message);
    }
  };
  const addClip = () => {
    const source = chosenSource || doc.sources[0]?.id,
      track = selected.kind === "tracks" ? selected.id : doc.tracks[0]?.id;
    if (!source || !track) {
      setError("先添加音轨和音源，再添加片段");
      return;
    }
    const id = uid("clip"),
      start = Math.min(position, Math.max(0, state.duration - 0.1)),
      duration = Math.min(3, state.duration - start);
    change((d) =>
      d.clips.push({
        id,
        track,
        source,
        start,
        duration,
        offset: 0,
        phase: 0,
        rate: 1,
        gain: 1,
        pan: 0,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        fadeOffset: 0,
        automation: [],
      }),
    );
    setSelected({ kind: "clips", id });
  };
  const remove = () => {
    if (selected.kind === "master") return;
    change((d) => {
      d[selected.kind] = d[selected.kind].filter((v) => v.id !== selected.id);
      if (selected.kind === "tracks") {
        d.clips = d.clips.filter((c) => c.track !== selected.id);
        for (const c of [...d.tracks, ...d.buses, d.master])
          c.processors = c.processors.filter(
            (p) => p.type !== "duck" || p.track !== selected.id,
          );
      }
      if (selected.kind === "buses")
        for (const c of [...d.tracks, ...d.buses]) {
          if (c.output === selected.id) c.output = "master";
          c.sends = c.sends.filter((s) => s.bus !== selected.id);
        }
    });
    setSelected({ kind: "master" });
  };
  const split = () => {
    if (selected.kind !== "clips") return;
    try {
      const next = editAudioDocument(
        doc,
        [{ op: "split", id: selected.id, at: position, newId: uid("clip") }],
        { projectId: work.project, duration: state.duration },
      );
      change((d) => Object.assign(d, next));
    } catch (e) {
      setError(e.message);
    }
  };
  const beginDrag = (e, c, mode) => {
    if (blocked || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    // Dragging suppresses normal focus changes, so commit before capturing.
    if (!flushNumericPending(editorElement.current)) return;
    const latest = current.current;
    const clip = latest.clips.find((item) => item.id === c.id);
    if (!clip) return;
    target.setPointerCapture(e.pointerId);
    const row = target.closest(".audio-lane");
    drag.current = {
      before: structuredClone(latest),
      clip: { ...clip },
      x: e.clientX,
      width: row.getBoundingClientRect().width,
      mode,
    };
    setSelected({ kind: "clips", id: c.id });
  };
  const moveDrag = (e) => {
    const a = drag.current;
    if (!a) return;
    let delta = ((e.clientX - a.x) / a.width) * state.duration;
    if (!e.altKey) delta = Math.round(delta * state.fps) / state.fps;
    const next = structuredClone(a.before),
      c = next.clips.find((c) => c.id === a.clip.id);
    if (a.mode === "move") {
      c.start = Math.max(
        0,
        Math.min(state.duration - c.duration, a.clip.start + delta),
      );
      const row = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-audio-track]");
      if (row) c.track = row.dataset.audioTrack;
    } else if (a.mode === "end")
      c.duration = Math.max(
        1 / state.fps,
        Math.min(state.duration - c.start, a.clip.duration + delta),
      );
    else {
      delta = Math.max(
        -a.clip.start,
        -(a.clip.phase ?? 0) / a.clip.rate,
        Math.min(a.clip.duration - 1 / state.fps, delta),
      );
      c.start = a.clip.start + delta;
      c.duration = a.clip.duration - delta;
      c.phase = (a.clip.phase ?? 0) + delta * c.rate;
      c.fadeOffset = (a.clip.fadeOffset ?? 0) + delta;
      c.fadeDuration = a.clip.fadeDuration ?? a.clip.duration;
    }
    setDoc(next);
  };
  const endDrag = () => {
    if (drag.current) {
      const before = drag.current.before;
      drag.current = null;
      if (JSON.stringify(current.current) !== JSON.stringify(before)) {
        setPast((p) => [...p.slice(-49), before]);
        setFuture([]);
      }
    }
  };
  const cancelDrag = (e) => {
    if (!drag.current) return;
    const before = drag.current.before;
    drag.current = null;
    setDoc(before);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  if (!doc)
    return (
      <div className="audio-editor">
        <ErrorNote error={error} />
        {busy ? (
          <Loading />
        ) : (
          <Button disabled={blocked} onClick={() => load(false)}>
            加载音频工程
          </Button>
        )}
      </div>
    );
  const item =
    selected.kind === "master"
      ? doc.master
      : doc[selected.kind]?.find((v) => v.id === selected.id);
  const editItem = (key, value) =>
    change((d) => {
      const target =
        selected.kind === "master"
          ? d.master
          : d[selected.kind].find((v) => v.id === selected.id);
      target[key] = value;
    });
  const effectList = item?.processors;
  const addEffect = () => {
    try {
      const p = audioProcessorSchema.parse({
        type: processor,
        ...(processor === "duck" ? { track: doc.tracks[0]?.id } : {}),
        ...(processor === "tone"
          ? { effect: "Reverb", options: defaultToneOptions("Reverb") }
          : {}),
        id: uid("fx"),
      });
      editItem("processors", [...effectList, p]);
      setError("");
    } catch (e) {
      setError(
        processor === "duck" && !doc.tracks.length
          ? "请先添加触发轨道"
          : "无法添加处理器：" +
              (e.issues
                ?.map((issue) => issue.path.join(".") + ": " + issue.message)
                .join("；") || e.message),
      );
    }
  };
  const setEffect = (i, key, value) => {
    const effects = structuredClone(effectList);
    effects[i][key] = value;
    editItem("processors", effects);
  };
  const numberField = (key, label, min, step = 0.01, max) => (
    <label key={key}>
      {label}
      <NumberInput
        aria-label={label}
        identity={`${selected.kind}:${selected.id ?? "master"}:${key}`}
        min={min}
        max={max}
        step={step}
        value={item[key] ?? 0}
        disabled={blocked}
        onCommit={(value) => editItem(key, value)}
      />
    </label>
  );
  const content = (
    <div
      ref={editorElement}
      className="audio-editor"
      role="region"
      aria-label="多轨音频编辑器"
      onKeyDown={(e) => {
        if (
          !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) &&
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === "z"
        ) {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
      }}
      tabIndex={-1}
    >
      <div className="audio-toolbar">
        <div>
          <Music2 size={18} />
          <strong>音频工作台</strong>
          <span className="audio-status">
            {dirty
              ? "未保存"
              : state.declared
                ? "已保存"
                : "兼容音轨 · 保存后启用新工程"}
          </span>
        </div>
        <div>
          <Button
            onClick={undo}
            disabled={!past.length || blocked}
            title="撤销"
          >
            <Undo2 size={16} />
          </Button>
          <Button
            onClick={redo}
            disabled={!future.length || blocked}
            title="重做"
          >
            <Redo2 size={16} />
          </Button>
          {dirty && (
            <Button onClick={() => load(false)} disabled={blocked}>
              放弃未保存修改
            </Button>
          )}
          <Button
            onClick={() => load(false)}
            disabled={blocked || dirty}
            title="刷新"
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            onClick={save}
            disabled={blocked || (!dirty && state.declared)}
          >
            <Save size={16} />
            保存混音
          </Button>
        </div>
      </div>
      <ErrorNote error={error} />
      <p className="audio-hint">
        工程混音用于所有正式导出。播放器音量与独奏只影响监听。
      </p>
      <div className="audio-actions">
        <Button onClick={addTrack} disabled={blocked}>
          <Plus size={15} />
          音轨
        </Button>
        <Button onClick={addClip} disabled={blocked || !doc.sources.length}>
          <Plus size={15} />
          片段
        </Button>
        <Button onClick={split} disabled={blocked || selected.kind !== "clips"}>
          <Scissors size={15} />
          在播放头分割
        </Button>
        <label>
          缩放
          <input
            disabled={blocked}
            aria-label="音频时间轴缩放"
            type="range"
            min="1"
            max="8"
            step=".25"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="audio-timeline" role="region" aria-label="多轨音频时间轴">
        <div style={{ minWidth: Math.max(500, 500 * zoom) }}>
          <div className="audio-ruler">
            <span>音轨</span>
            <div
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onSeek?.(((e.clientX - r.left) / r.width) * state.duration);
              }}
            >
              {Array.from({ length: 11 }, (_, i) => (
                <b key={i} style={{ left: i * 10 + "%" }}>
                  {((state.duration * i) / 10).toFixed(1)}s
                </b>
              ))}
            </div>
          </div>
          {doc.tracks.map((t) => (
            <div
              className={
                "audio-row " +
                (selected.kind === "tracks" && selected.id === t.id
                  ? "selected"
                  : "")
              }
              key={t.id}
            >
              <button
                disabled={blocked}
                className="audio-track-name"
                onClick={() => setSelected({ kind: "tracks", id: t.id })}
              >
                <Volume2 size={14} />
                <span>{t.name}</span>
                {t.muted && <small>静音</small>}
              </button>
              <div className="audio-lane" data-audio-track={t.id}>
                <i
                  className="audio-playhead"
                  style={{ left: (position / state.duration) * 100 + "%" }}
                />
                {(clipsByTrack.get(t.id) ?? []).map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    aria-label={"音频片段 " + (c.name ?? c.id)}
                    className={
                      "audio-clip " +
                      (selected.id === c.id ? "selected" : "") +
                      (c.muted ? " muted" : "")
                    }
                    style={{
                      left: (c.start / state.duration) * 100 + "%",
                      width: (c.duration / state.duration) * 100 + "%",
                    }}
                    onClick={() => setSelected({ kind: "clips", id: c.id })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected({ kind: "clips", id: c.id });
                      }
                    }}
                    onPointerDown={(e) => beginDrag(e, c, "move")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  >
                    {
                      <ClipWaveform
                        clip={c}
                        info={waveforms[sourcesById.get(c.source)?.src]}
                      />
                    }
                    <span
                      className="audio-trim left"
                      onPointerDown={(e) => beginDrag(e, c, "start")}
                    />
                    <span>
                      {c.name ??
                        sourcesById.get(c.source)?.src?.split("/").at(-1) ??
                        c.source}
                    </span>
                    <small>{c.rate}×</small>
                    <span
                      className="audio-trim right"
                      onPointerDown={(e) => beginDrag(e, c, "end")}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!doc.tracks.length && (
            <div className="audio-empty">
              <Music2 size={24} />
              <p>添加音轨，组合音乐、旁白、音效与程序生成的声音。</p>
              <Button disabled={blocked} onClick={addTrack}>
                添加第一条音轨
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="audio-bottom">
        <section className="audio-sources">
          <h3>音源</h3>
          <div className="audio-form">
            <label>
              来源
              <select
                disabled={blocked}
                value={sourceKind}
                onChange={(e) => setSourceKind(e.target.value)}
              >
                <option value="file">音频 / 视频素材</option>
                <option value="generated">程序生成</option>
              </select>
            </label>
            {sourceKind === "file" ? (
              <label>
                项目素材
                <select
                  disabled={blocked}
                  aria-label="音频素材"
                  value={sourceFile}
                  onChange={(e) => setSourceFile(e.target.value)}
                >
                  <option value="">选择已导入素材</option>
                  {files
                    .filter(
                      (f) =>
                        /^public\//.test(f.path) &&
                        /\.(wav|mp3|flac|ogg|opus|m4a|aac|aiff?|wma|caf|mp4|webm)$/i.test(
                          f.path,
                        ),
                    )
                    .map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path.slice(7)}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  引擎
                  <select
                    disabled={blocked}
                    value={engine}
                    onChange={(e) => setEngine(e.target.value)}
                  >
                    {state.engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  模块名
                  <input
                    disabled={blocked}
                    value={module}
                    onChange={(e) => setModule(e.target.value)}
                    placeholder="audio.ts 注册的模块名"
                  />
                </label>
                <label>
                  生成器轨道
                  <input
                    disabled={blocked}
                    value={sourceTrack}
                    onChange={(e) => setSourceTrack(e.target.value)}
                  />
                </label>
              </>
            )}
            <Button onClick={addSource} disabled={blocked}>
              <Plus size={14} />
              添加音源
            </Button>
            {sourceKind === "file" && (
              <div className="audio-wide audio-key">
                <select
                  disabled={blocked}
                  aria-label="音频转换格式"
                  value={conversion}
                  onChange={(e) => setConversion(e.target.value)}
                >
                  {["wav", "flac", "mp3", "ogg", "m4a"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
                <Button disabled={blocked || !sourceFile} onClick={transcode}>
                  转换副本
                </Button>
              </div>
            )}
          </div>
          <div className="audio-source-list">
            {doc.sources.map((s) => (
              <button
                disabled={blocked}
                key={s.id}
                className={chosenSource === s.id ? "selected" : ""}
                onClick={() => setChosenSource(s.id)}
              >
                <Music2 size={14} />
                <span>
                  {s.kind === "file"
                    ? s.src.split("/").at(-1)
                    : s.module + " / " + s.trackId}
                </span>
                <small>{s.kind === "file" ? "素材" : s.engine}</small>
              </button>
            ))}
          </div>
          {chosenSource && (
            <Button
              disabled={
                blocked || doc.clips.some((c) => c.source === chosenSource)
              }
              onClick={() => {
                change((d) => {
                  d.sources = d.sources.filter((s) => s.id !== chosenSource);
                });
                setChosenSource("");
              }}
            >
              移除未使用音源
            </Button>
          )}
          {waveforms[doc.sources.find((s) => s.id === chosenSource)?.src] &&
            (() => {
              const info =
                waveforms[doc.sources.find((s) => s.id === chosenSource).src];
              return (
                <p className="audio-hint">
                  {info.sampleRate} Hz · {info.channels} 声道 · 峰值{" "}
                  {info.peakDb?.toFixed(1) ?? "−∞"} dBFS · RMS{" "}
                  {info.rmsDb?.toFixed(1) ?? "−∞"} dBFS
                  {info.clippedSamples > 0 ? " · 检测到满幅采样" : ""}
                </p>
              );
            })()}
          <h3>路由与主输出</h3>
          <div className="audio-source-list">
            <button
              disabled={blocked}
              onClick={() => setSelected({ kind: "master" })}
            >
              <SlidersHorizontal size={14} />
              主输出
            </button>
            {doc.buses.map((b) => (
              <button
                disabled={blocked}
                key={b.id}
                onClick={() => setSelected({ kind: "buses", id: b.id })}
              >
                {b.name}
              </button>
            ))}
          </div>
          <Button
            disabled={blocked}
            onClick={() => {
              const id = uid("bus");
              change((d) =>
                d.buses.push({
                  id,
                  name: "分组总线 " + (d.buses.length + 1),
                  gain: 1,
                  pan: 0,
                  muted: false,
                  processors: [],
                  output: "master",
                  sends: [],
                }),
              );
              setSelected({ kind: "buses", id });
            }}
          >
            <Plus size={14} />
            分组总线
          </Button>
        </section>
        <section className="audio-inspector">
          <div className="audio-section-title">
            <h3>
              {selected.kind === "master"
                ? "主输出"
                : selected.kind === "clips"
                  ? "片段属性"
                  : selected.kind === "buses"
                    ? "总线混音"
                    : "轨道混音"}
            </h3>
            {selected.kind !== "master" && (
              <Button onClick={remove} disabled={blocked} title="删除所选项">
                <Trash2 size={15} />
              </Button>
            )}
          </div>
          {item && (
            <div className="audio-form">
              {selected.kind !== "master" && (
                <label>
                  名称
                  <input
                    value={item.name ?? ""}
                    onChange={(e) => editItem("name", e.target.value)}
                    disabled={blocked}
                  />
                </label>
              )}
              {numberField("gain", "作品增益", 0, 0.01, 4)}
              {selected.kind !== "master" && (
                <>
                  {numberField("pan", "声像", -1, 0.01, 1)}
                  <label className="audio-check">
                    <input
                      type="checkbox"
                      checked={!!item.muted}
                      onChange={(e) => editItem("muted", e.target.checked)}
                      disabled={blocked}
                    />
                    作品静音
                  </label>
                </>
              )}
              {selected.kind === "clips" && (
                <>
                  <label>
                    轨道
                    <select
                      disabled={blocked}
                      value={item.track}
                      onChange={(e) => editItem("track", e.target.value)}
                    >
                      {doc.tracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    音源
                    <select
                      disabled={blocked}
                      value={item.source}
                      onChange={(e) => editItem("source", e.target.value)}
                    >
                      {doc.sources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.src?.split("/").at(-1) ??
                            s.module + " / " + s.trackId}
                        </option>
                      ))}
                    </select>
                  </label>
                  {numberField("start", "开始秒", 0)}
                  {numberField("duration", "时长秒", 0.001)}
                  {numberField("offset", "素材入点秒", 0)}
                  {numberField("rate", "速度倍率", 0.05, 0.01, 16)}
                  {doc.sources.find((source) => source.id === item.source)
                    ?.kind === "file" && (
                    <>
                      {numberField("pitch", "移调半音", -48, 1, 48)}
                      <label className="audio-check">
                        <input
                          type="checkbox"
                          checked={!!item.preservePitch}
                          disabled={blocked}
                          onChange={(event) =>
                            editItem("preservePitch", event.target.checked)
                          }
                        />
                        变速时保持音高
                      </label>
                      <div className="audio-wide audio-pitch-tools">
                        <Button
                          disabled={blocked}
                          onClick={() =>
                            editItem(
                              "pitch",
                              Math.max(-48, (item.pitch ?? 0) - 12),
                            )
                          }
                        >
                          降八度
                        </Button>
                        <Button
                          disabled={blocked}
                          onClick={() =>
                            editItem(
                              "pitch",
                              Math.min(48, (item.pitch ?? 0) + 12),
                            )
                          }
                        >
                          升八度
                        </Button>
                        <Button
                          disabled={blocked}
                          onClick={() =>
                            change((document) => {
                              const clip = document.clips.find(
                                (clip) => clip.id === item.id,
                              );
                              clip.pitch = 0;
                              clip.rate = 1;
                              clip.preservePitch = false;
                              delete clip.stretch;
                            })
                          }
                        >
                          重置音高与速度
                        </Button>
                        <small>
                          移调范围 ±48
                          半音。保持音高后，速度只改变节奏；关闭时速度也改变音高。
                        </small>
                      </div>
                      <details className="audio-wide audio-stretch-settings">
                        <summary>高级音色与处理质量 · Signalsmith</summary>
                        <div className="audio-stretch-grid">
                          <label>
                            处理预设
                            <select
                              value={stretchMode(item.stretch)}
                              disabled={blocked}
                              onChange={(event) =>
                                editItem(
                                  "stretch",
                                  stretchPreset(
                                    item.stretch,
                                    event.target.value,
                                  ),
                                )
                              }
                            >
                              <option value="default">标准质量</option>
                              <option value="cheaper">节省计算</option>
                              <option value="manual">手动窗口与间隔</option>
                            </select>
                          </label>
                          {[
                            [
                              "formantSemitones",
                              "共振峰移调半音",
                              -48,
                              48,
                              0,
                              1,
                            ],
                            [
                              "tonalityHz",
                              "音调处理上限 Hz",
                              20,
                              24000,
                              8000,
                              100,
                            ],
                            [
                              "formantBaseHz",
                              "共振峰基频 Hz（0 自动）",
                              0,
                              2000,
                              0,
                              1,
                            ],
                            ["blockMs", "分析窗口毫秒（0 自动）", 0, 500, 0, 1],
                            [
                              "intervalMs",
                              "处理间隔毫秒（0 自动）",
                              0,
                              250,
                              0,
                              1,
                            ],
                          ].map(([key, title, min, max, fallback, step]) => (
                            <label key={key}>
                              {title}
                              <NumberInput
                                aria-label={title}
                                identity={`${item.id}:stretch:${key}`}
                                min={min}
                                max={
                                  key === "intervalMs"
                                    ? Math.min(
                                        max,
                                        item.stretch?.blockMs || max,
                                      )
                                    : max
                                }
                                step={step}
                                value={item.stretch?.[key] ?? fallback}
                                disabled={
                                  blocked ||
                                  (["blockMs", "intervalMs"].includes(key) &&
                                    stretchMode(item.stretch) !== "manual")
                                }
                                onCommit={(value) => {
                                  const next = {
                                    ...item.stretch,
                                    [key]: value,
                                  };
                                  if (key === "blockMs") {
                                    if (!value) next.intervalMs = 0;
                                    else if (next.intervalMs > value)
                                      next.intervalMs = value;
                                  }
                                  editItem("stretch", next);
                                }}
                              />
                            </label>
                          ))}
                          <small className="audio-wide audio-hint">
                            {stretchMode(item.stretch) === "manual"
                              ? "手动窗口覆盖质量预设；处理间隔不能大于分析窗口。切换质量预设会清除这两个覆盖值。"
                              : "质量预设自动设置分析窗口与处理间隔；选择手动模式后可调整。"}
                          </small>
                          <label className="audio-check">
                            <input
                              type="checkbox"
                              checked={!!item.stretch?.formantCompensation}
                              disabled={blocked}
                              onChange={(event) =>
                                editItem("stretch", {
                                  ...item.stretch,
                                  formantCompensation: event.target.checked,
                                })
                              }
                            />
                            补偿变调后的人声音色
                          </label>
                          <label className="audio-check">
                            <input
                              type="checkbox"
                              checked={!!item.stretch?.splitComputation}
                              disabled={blocked}
                              onChange={(event) =>
                                editItem("stretch", {
                                  ...item.stretch,
                                  splitComputation: event.target.checked,
                                })
                              }
                            />
                            分散处理计算
                          </label>
                        </div>
                      </details>
                    </>
                  )}
                  {numberField("fadeIn", "淡入秒", 0)}
                  {numberField("fadeOut", "淡出秒", 0)}
                  <label className="audio-check">
                    <input
                      disabled={blocked}
                      type="checkbox"
                      checked={!!item.loop}
                      onChange={(e) => {
                        if (e.target.checked) editItem("loop", 1);
                        else
                          change((d) => {
                            delete d.clips.find((c) => c.id === item.id).loop;
                          });
                      }}
                    />
                    循环素材
                  </label>
                  {item.loop && numberField("loop", "循环长度秒", 0.01)}
                  <div className="audio-wide">
                    <h4>音量自动化</h4>
                    {(item.automation ?? []).map((k, i) => (
                      <div className="audio-key" key={i}>
                        <NumberInput
                          disabled={blocked}
                          aria-label={"关键帧 " + (i + 1) + " 时间"}
                          identity={`${item.id}:automation:${i}:at`}
                          min={0}
                          step={0.01}
                          value={k.at}
                          onCommit={(value) => {
                            const a = structuredClone(item.automation);
                            a[i].at = value;
                            editItem("automation", a);
                          }}
                        />
                        <NumberInput
                          disabled={blocked}
                          aria-label={"关键帧 " + (i + 1) + " 增益"}
                          identity={`${item.id}:automation:${i}:gain`}
                          min={0}
                          max={4}
                          step={0.01}
                          value={k.value}
                          onCommit={(value) => {
                            const a = structuredClone(item.automation);
                            a[i].value = value;
                            editItem("automation", a);
                          }}
                        />
                        <Button
                          disabled={blocked}
                          onClick={() =>
                            editItem(
                              "automation",
                              item.automation.filter((_, j) => i !== j),
                            )
                          }
                          title="删除关键帧"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      disabled={blocked}
                      onClick={() =>
                        editItem(
                          "automation",
                          [
                            ...(item.automation ?? []),
                            {
                              at: Math.max(
                                0,
                                position - item.start + (item.fadeOffset ?? 0),
                              ),
                              value: 1,
                              easing: "linear",
                            },
                          ].sort((a, b) => a.at - b.at),
                        )
                      }
                    >
                      在播放头添加关键帧
                    </Button>
                  </div>
                </>
              )}
              {item.output && (
                <>
                  <label>
                    输出到
                    <select
                      disabled={blocked}
                      value={item.output}
                      onChange={(e) => editItem("output", e.target.value)}
                    >
                      <option value="master">主输出</option>
                      {doc.buses
                        .filter((b) => b.id !== item.id)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="audio-wide">
                    <h4>发送</h4>
                    {(item.sends ?? []).map((s, i) => (
                      <div className="audio-key" key={i}>
                        <select
                          disabled={blocked}
                          value={s.bus}
                          onChange={(e) => {
                            const a = structuredClone(item.sends);
                            a[i].bus = e.target.value;
                            editItem("sends", a);
                          }}
                        >
                          {doc.buses
                            .filter((b) => b.id !== item.id)
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                        </select>
                        <NumberInput
                          disabled={blocked}
                          aria-label="发送增益"
                          identity={`${item.id}:send:${i}:gain`}
                          min={0}
                          max={2}
                          step={0.01}
                          value={s.gain}
                          onCommit={(value) => {
                            const a = structuredClone(item.sends);
                            a[i].gain = value;
                            editItem("sends", a);
                          }}
                        />
                        <Button
                          disabled={blocked}
                          onClick={() =>
                            editItem(
                              "sends",
                              item.sends.filter((_, j) => i !== j),
                            )
                          }
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      disabled={
                        blocked || !doc.buses.some((b) => b.id !== item.id)
                      }
                      onClick={() =>
                        editItem("sends", [
                          ...item.sends,
                          {
                            bus: doc.buses.find((b) => b.id !== item.id).id,
                            gain: 0.25,
                          },
                        ])
                      }
                    >
                      添加发送
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {effectList && (
            <div className="audio-effects">
              <h4>处理链 · 从上到下</h4>
              {effectList.map((fx, i) => (
                <div className="audio-effect" key={fx.id ?? i}>
                  <header>
                    <strong>
                      {audioProcessors.find((p) => p.id === fx.type)?.name}
                      {fx.type === "tone" ? " · " + fx.effect : ""}
                    </strong>
                    <label>
                      <input
                        disabled={blocked}
                        type="checkbox"
                        checked={!fx.bypass}
                        onChange={(e) =>
                          setEffect(i, "bypass", !e.target.checked)
                        }
                      />
                      启用
                    </label>
                    <Button
                      disabled={blocked || i === 0}
                      onClick={() => {
                        const a = [...effectList];
                        [a[i - 1], a[i]] = [a[i], a[i - 1]];
                        editItem("processors", a);
                      }}
                      title="上移处理器"
                    >
                      ↑
                    </Button>
                    <Button
                      disabled={blocked}
                      onClick={() =>
                        editItem(
                          "processors",
                          effectList.filter((_, j) => i !== j),
                        )
                      }
                      title="删除处理器"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </header>
                  {fx.type === "tone" ? (
                    <ToneEffectEditor
                      fx={fx}
                      index={i}
                      disabled={blocked}
                      onChange={(next) => {
                        const effects = structuredClone(effectList);
                        effects[i] = next;
                        editItem("processors", effects);
                      }}
                    />
                  ) : (
                    <div className="audio-form">
                      {Object.entries(fx)
                        .filter(([k]) => !["type", "id", "bypass"].includes(k))
                        .map(([k, v]) => (
                          <label key={k}>
                            {labels[k] ?? k}
                            {k === "mode" ? (
                              <select
                                disabled={blocked}
                                value={v}
                                onChange={(e) =>
                                  setEffect(i, k, e.target.value)
                                }
                              >
                                {[
                                  "lowpass",
                                  "highpass",
                                  "bandpass",
                                  "notch",
                                  "lowshelf",
                                  "highshelf",
                                  "peaking",
                                  "allpass",
                                ].map((v) => (
                                  <option key={v}>{v}</option>
                                ))}
                              </select>
                            ) : k === "track" ? (
                              <select
                                disabled={blocked}
                                value={v}
                                onChange={(e) =>
                                  setEffect(i, k, e.target.value)
                                }
                              >
                                {doc.tracks.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <NumberInput
                                disabled={blocked}
                                aria-label={`${audioProcessors.find((p) => p.id === fx.type)?.name} ${labels[k] ?? k}`}
                                identity={`${item.id}:${fx.id ?? i}:${k}`}
                                step={0.01}
                                value={v}
                                onCommit={(value) => setEffect(i, k, value)}
                              />
                            )}
                          </label>
                        ))}
                    </div>
                  )}
                </div>
              ))}
              <div className="audio-key">
                <select
                  disabled={blocked}
                  aria-label="选择音频处理器"
                  value={processor}
                  onChange={(e) => setProcessor(e.target.value)}
                >
                  {audioProcessors.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={addEffect}
                  disabled={blocked || effectList.length >= 16}
                >
                  <Plus size={14} />
                  处理器
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
  return (
    <NumericDraftProvider
      onDirtyChange={setNumericDirty}
      resetKey={`${work.id}:${numericReset}`}
    >
      {content}
    </NumericDraftProvider>
  );
}
