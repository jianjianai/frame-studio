import { useEffect, useState, type ReactNode } from "react";
import { Layers, AudioLines, Captions, Flag, Film, Crosshair, Sparkles } from "lucide-react";
import { api, formatTime, workPath } from "../lib/api";
import { useAction } from "../lib/ui";
import type { AudioDocument, VisualClip } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { VolumeSlider, formatDb } from "../workbench/Timeline";
import { ViewHeader } from "./ViewHeader";

type Animated = number | { at: number; value: number; easing?: string }[] | undefined;

const FITS = [
  { value: "contain", label: "完整显示（留边）" },
  { value: "cover", label: "铺满（裁切）" },
  { value: "fill", label: "拉伸" },
];
const BLENDS = [
  { value: "source-over", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "screen", label: "滤色" },
  { value: "overlay", label: "叠加" },
  { value: "darken", label: "变暗" },
  { value: "lighten", label: "变亮" },
  { value: "difference", label: "差值" },
  { value: "destination-in", label: "作为遮罩" },
  { value: "destination-out", label: "挖空" },
];

/**
 * Properties of the object selected on the timeline (layer, audio clip, track, subtitle,
 * shot marker), or of the work when nothing is selected. Every change is saved at once
 * and is one step of the timeline's undo history.
 */
export function PropertiesView() {
  const { work, selection, history, stage, addToChat, showView, readOnly } = useWorkbench();
  const [run] = useAction();
  const meta = work.meta;
  const base = workPath(work.repo, work.id);
  const audio = meta?.audioDocument as AudioDocument | undefined;

  const layerUpdate = (id: string, label: string, patch: Record<string, unknown>, unset: string[] = []) =>
    run(() =>
      history.run("layers", label, () => api(`${base}/layers`, { body: { operations: [{ op: "update", id, patch, ...(unset.length ? { unset } : {}) }] } })),
    );
  const audioPut = (collection: "clips" | "tracks", label: string, value: unknown) =>
    run(() => history.run("audio", label, () => api(`${base}/audio`, { body: { operations: [{ op: "put", collection, value }] } })));
  const projectPatch = (label: string, change: Record<string, unknown>) =>
    run(() => history.run("project", label, () => api(base, { method: "PATCH", body: change })));

  if (!meta) return <div className="empty">project.ts 无法读取：{work.metaError}</div>;

  const layer = selection?.kind === "layer" ? meta.visual?.clips.find((clip) => clip.id === selection.id) : undefined;
  const clip = selection?.kind === "audio" ? audio?.clips.find((item) => item.id === selection.id) : undefined;
  const track = selection?.kind === "track" ? audio?.tracks.find((item) => item.id === selection.id) : undefined;
  const subtitle = selection?.kind === "subtitle" && selection.index !== undefined ? meta.subtitles[selection.index] : undefined;
  const beat = selection?.kind === "beat" && selection.index !== undefined ? meta.beats[selection.index] : undefined;
  const seek = (time: number) => void stage.seek(time);

  let body: ReactNode;
  if (layer) {
    const transform = (layer.transform as Record<string, Animated> | undefined) ?? {};
    const setTransform = (key: string, value: number) => layerUpdate(layer.id, "修改画面", { transform: { ...transform, [key]: value } });
    const layerAudio = layer.audio as { enabled: boolean; gain?: number; muted?: boolean } | undefined;
    const parameters = layer.source.kind === "scene" ? ((layer.source as { parameters?: Record<string, number> }).parameters ?? {}) : {};
    body = (
      <>
        <Head
          icon={<Layers size={15} />}
          kind="图层"
          title={layer.name || layer.id}
          onSeek={() => seek(layer.start)}
          onAsk={() => addToChat({ type: "layer", id: layer.id, name: layer.name })}
        />
        <Section title="基本">
          <Prop label="名称">
            <TextField
              value={layer.name ?? ""}
              placeholder={layer.id}
              onCommit={(name) => layerUpdate(layer.id, "重命名图层", name ? { name } : {}, name ? [] : ["name"])}
            />
          </Prop>
          <Prop label="来源">
            <span className="prop-static mono" title={sourceLabel(layer)}>
              {sourceLabel(layer)}
            </span>
          </Prop>
          {layer.source.kind === "color" && (
            <Prop label="颜色">
              <input
                type="color"
                className="prop-color"
                value={(layer.source.color ?? "#000000").slice(0, 7)}
                onChange={() => {}}
                onBlur={(event) =>
                  event.target.value !== layer.source.color && layerUpdate(layer.id, "修改颜色", { source: { ...layer.source, color: event.target.value } })
                }
              />
            </Prop>
          )}
          <Prop label="显示">
            <Check
              checked={!layer.hidden}
              label="在画面中显示"
              onChange={(shown) => layerUpdate(layer.id, shown ? "显示图层" : "隐藏图层", shown ? {} : { hidden: true }, shown ? ["hidden"] : [])}
            />
          </Prop>
        </Section>
        <Section title="时间">
          <Prop label="开始">
            <NumberField
              value={layer.start}
              unit="秒"
              min={0}
              step={0.1}
              hint={formatTime(layer.start)}
              onCommit={(start) => layerUpdate(layer.id, "修改开始时间", { start })}
            />
          </Prop>
          <Prop label="时长">
            <NumberField value={layer.duration} unit="秒" min={0.05} step={0.1} onCommit={(duration) => layerUpdate(layer.id, "修改时长", { duration })} />
          </Prop>
          <Prop label="素材起点">
            <NumberField
              value={(layer.offset as number) ?? 0}
              unit="秒"
              min={0}
              step={0.1}
              onCommit={(offset) => layerUpdate(layer.id, "修改素材起点", { offset })}
            />
          </Prop>
          <Prop label="速度">
            <NumberField
              value={(layer.rate as number) ?? 1}
              unit="×"
              min={0.05}
              max={16}
              step={0.1}
              onCommit={(rate) => layerUpdate(layer.id, "修改速度", { rate })}
            />
          </Prop>
          <Prop label="循环长度">
            <NumberField
              value={(layer.loop as number | undefined) ?? null}
              unit="秒"
              min={0.05}
              step={0.1}
              placeholder="不循环"
              onCommit={(loop) => layerUpdate(layer.id, "修改循环", loop === null ? {} : { loop }, loop === null ? ["loop"] : [])}
            />
          </Prop>
        </Section>
        <Section title="画面">
          <div className="prop-grid2">
            {(
              [
                ["x", "X", 0],
                ["y", "Y", 0],
                ["width", "宽", 1],
                ["height", "高", 1],
              ] as const
            ).map(([key, label, fallback]) => (
              <Prop key={key} label={label}>
                <AnimatedField value={transform[key]} fallback={fallback} scale={100} unit="%" step={1} onCommit={(value) => setTransform(key, value)} />
              </Prop>
            ))}
          </div>
          <Prop label="旋转">
            <AnimatedField value={transform.rotation} fallback={0} unit="°" step={1} onCommit={(value) => setTransform("rotation", value)} />
          </Prop>
          <Prop label="不透明度">
            <AnimatedField
              value={transform.opacity}
              fallback={1}
              scale={100}
              unit="%"
              step={1}
              min={0}
              max={100}
              onCommit={(value) => setTransform("opacity", value)}
            />
          </Prop>
          <Prop label="适应">
            <Select value={(layer.fit as string) ?? "contain"} options={FITS} onChange={(fit) => layerUpdate(layer.id, "修改适应方式", { fit })} />
          </Prop>
          <Prop label="混合">
            <Select value={(layer.blend as string) ?? "source-over"} options={BLENDS} onChange={(blend) => layerUpdate(layer.id, "修改混合模式", { blend })} />
          </Prop>
        </Section>
        <Section title="淡入淡出">
          <Prop label="淡入">
            <NumberField
              value={(layer.fadeIn as number) ?? 0}
              unit="秒"
              min={0}
              step={0.1}
              onCommit={(fadeIn) => layerUpdate(layer.id, "修改淡入", { fadeIn })}
            />
          </Prop>
          <Prop label="淡出">
            <NumberField
              value={(layer.fadeOut as number) ?? 0}
              unit="秒"
              min={0}
              step={0.1}
              onCommit={(fadeOut) => layerUpdate(layer.id, "修改淡出", { fadeOut })}
            />
          </Prop>
        </Section>
        {layer.source.kind === "video" && (
          <Section title="原声">
            <Prop label="使用原声">
              <Check
                checked={Boolean(layerAudio?.enabled)}
                label="把视频的声音加入混音"
                onChange={(enabled) => layerUpdate(layer.id, enabled ? "启用原声" : "关闭原声", { audio: { ...(layerAudio ?? {}), enabled } })}
              />
            </Prop>
            {layerAudio?.enabled && (
              <>
                <Prop label="音量">
                  <Volume gain={layerAudio.gain ?? 1} onCommit={(gain) => layerUpdate(layer.id, "调整音量", { audio: { ...layerAudio, gain } })} />
                </Prop>
                <Prop label="静音">
                  <Check
                    checked={Boolean(layerAudio.muted)}
                    label="静音"
                    onChange={(muted) => layerUpdate(layer.id, "静音", { audio: { ...layerAudio, muted } })}
                  />
                </Prop>
              </>
            )}
          </Section>
        )}
        {Object.keys(parameters).length > 0 && (
          <Section title="场景参数">
            {Object.entries(parameters).map(([key, value]) => (
              <Prop key={key} label={key}>
                <NumberField
                  value={value}
                  step={0.1}
                  onCommit={(next) =>
                    next !== null && layerUpdate(layer.id, "修改场景参数", { source: { ...layer.source, parameters: { ...parameters, [key]: next } } })
                  }
                />
              </Prop>
            ))}
          </Section>
        )}
      </>
    );
  } else if (clip && audio) {
    const source = audio.sources.find((item) => item.id === clip.source);
    const put = (label: string, change: Record<string, unknown>) => audioPut("clips", label, { ...clip, ...change });
    body = (
      <>
        <Head
          icon={<AudioLines size={15} />}
          kind="音频片段"
          title={clip.name || source?.src?.split("/").pop() || clip.id}
          onSeek={() => seek(clip.start)}
          onAsk={() => addToChat({ type: "range", start: clip.start, end: clip.start + clip.duration }, `音频片段「${clip.name || clip.id}」：`)}
        />
        <Section title="基本">
          <Prop label="名称">
            <TextField
              value={clip.name ?? ""}
              placeholder={source?.src?.split("/").pop() ?? clip.id}
              onCommit={(name) => {
                const { name: _old, ...rest } = clip;
                void _old;
                return audioPut("clips", "重命名片段", name ? { ...rest, name } : rest);
              }}
            />
          </Prop>
          <Prop label="音轨">
            <Select
              value={clip.track}
              options={audio.tracks.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(trackId) => put("移到其他音轨", { track: trackId })}
            />
          </Prop>
          <Prop label="来源">
            <span className="prop-static mono" title={source?.src ?? source?.module}>
              {source?.kind === "file" ? source.src?.replace(/^films\/[^/]+\//, "") : `生成：${source?.module ?? "?"}`}
            </span>
          </Prop>
        </Section>
        <Section title="时间">
          <Prop label="开始">
            <NumberField value={clip.start} unit="秒" min={0} step={0.1} hint={formatTime(clip.start)} onCommit={(start) => put("修改开始时间", { start })} />
          </Prop>
          <Prop label="时长">
            <NumberField value={clip.duration} unit="秒" min={0.05} step={0.1} onCommit={(duration) => put("修改时长", { duration })} />
          </Prop>
          <Prop label="素材起点">
            <NumberField value={clip.offset ?? 0} unit="秒" min={0} step={0.1} onCommit={(offset) => put("修改素材起点", { offset })} />
          </Prop>
          <Prop label="速度">
            <NumberField value={clip.rate ?? 1} unit="×" min={0.05} max={16} step={0.1} onCommit={(rate) => put("修改速度", { rate })} />
          </Prop>
          <Prop label="保持音高">
            <Check checked={Boolean(clip.preservePitch)} label="变速时不变调" onChange={(preservePitch) => put("修改音高设置", { preservePitch })} />
          </Prop>
          <Prop label="移调">
            <NumberField value={(clip.pitch as number) ?? 0} unit="半音" min={-48} max={48} step={1} onCommit={(pitch) => put("移调", { pitch })} />
          </Prop>
          <Prop label="循环长度">
            <NumberField
              value={(clip.loop as number | undefined) ?? null}
              unit="秒"
              min={0.01}
              step={0.1}
              placeholder="不循环"
              onCommit={(loop) => {
                const { loop: _old, ...rest } = clip;
                void _old;
                return audioPut("clips", "修改循环", loop === null ? rest : { ...rest, loop });
              }}
            />
          </Prop>
        </Section>
        <Section title="声音">
          <Prop label="音量">
            <Volume gain={clip.gain ?? 1} previewId={`audio:${clip.id}`} onCommit={(gain) => put("调整音量", { gain })} />
          </Prop>
          <Prop label="声像">
            <NumberField
              value={(clip.pan as number) ?? 0}
              min={-1}
              max={1}
              step={0.1}
              hint="-1 左 · 0 中 · 1 右"
              onCommit={(pan) => put("调整声像", { pan })}
            />
          </Prop>
          <Prop label="静音">
            <Check checked={Boolean(clip.muted)} label="静音这个片段" onChange={(muted) => put(muted ? "静音片段" : "取消静音", { muted })} />
          </Prop>
          <Prop label="淡入">
            <NumberField value={clip.fadeIn ?? 0} unit="秒" min={0} step={0.1} onCommit={(fadeIn) => put("修改淡入", { fadeIn })} />
          </Prop>
          <Prop label="淡出">
            <NumberField value={clip.fadeOut ?? 0} unit="秒" min={0} step={0.1} onCommit={(fadeOut) => put("修改淡出", { fadeOut })} />
          </Prop>
        </Section>
      </>
    );
  } else if (track && audio) {
    const put = (label: string, change: Record<string, unknown>) => audioPut("tracks", label, { ...track, ...change });
    const clips = audio.clips.filter((item) => item.track === track.id);
    body = (
      <>
        <Head icon={<AudioLines size={15} />} kind="音轨" title={track.name} />
        <Section title="基本">
          <Prop label="名称">
            <TextField value={track.name} onCommit={(name) => name && put("重命名音轨", { name })} />
          </Prop>
          <Prop label="片段">
            <span className="prop-static">{clips.length} 个</span>
          </Prop>
        </Section>
        <Section title="混音">
          <Prop label="音量">
            <Volume gain={track.gain} onCommit={(gain) => put("调整音量", { gain })} />
          </Prop>
          <Prop label="声像">
            <NumberField value={track.pan ?? 0} min={-1} max={1} step={0.1} hint="-1 左 · 0 中 · 1 右" onCommit={(pan) => put("调整声像", { pan })} />
          </Prop>
          <Prop label="静音">
            <Check checked={Boolean(track.muted)} label="静音整条音轨" onChange={(muted) => put(muted ? "静音音轨" : "取消静音", { muted })} />
          </Prop>
        </Section>
        {track.processors && track.processors.length > 0 && (
          <Section title="效果">
            <span className="prop-static">{track.processors.map((processor) => processor.type).join("、")}（让 AI 调整效果参数）</span>
          </Section>
        )}
      </>
    );
  } else if (subtitle && selection?.index !== undefined) {
    const index = selection.index;
    const save = (label: string, change: Partial<typeof subtitle>) =>
      projectPatch(label, {
        subtitles: meta.subtitles.map((item, i) => (i === index ? { ...item, ...change } : item)).sort((a, b) => a.start - b.start),
      });
    body = (
      <>
        <Head icon={<Captions size={15} />} kind="字幕" title={subtitle.text} onSeek={() => seek(subtitle.start)} />
        <Section title="字幕">
          <Prop label="文字">
            <TextField multiline value={subtitle.text} onCommit={(text) => text.trim() && save("修改字幕", { text: text.trim() })} />
          </Prop>
          <Prop label="开始">
            <NumberField
              value={subtitle.start}
              unit="秒"
              min={0}
              step={0.1}
              hint={formatTime(subtitle.start)}
              onCommit={(start) => save("修改字幕时间", { start })}
            />
          </Prop>
          <Prop label="结束">
            <NumberField value={subtitle.end} unit="秒" min={0} step={0.1} hint={formatTime(subtitle.end)} onCommit={(end) => save("修改字幕时间", { end })} />
          </Prop>
        </Section>
      </>
    );
  } else if (beat && selection?.index !== undefined) {
    const index = selection.index;
    const save = (label: string, change: Partial<typeof beat>) =>
      projectPatch(label, { beats: meta.beats.map((item, i) => (i === index ? { ...item, ...change } : item)).sort((a, b) => a.at - b.at) });
    body = (
      <>
        <Head icon={<Flag size={15} />} kind="镜头标记" title={beat.title} onSeek={() => seek(beat.at)} />
        <Section title="标记">
          <Prop label="名称">
            <TextField value={beat.title} onCommit={(title) => title && save("修改标记", { title })} />
          </Prop>
          <Prop label="说明">
            <TextField multiline value={beat.detail} placeholder="这个镜头要表现什么（AI 也会读取）" onCommit={(detail) => save("修改标记说明", { detail })} />
          </Prop>
          <Prop label="时间">
            <NumberField value={beat.at} unit="秒" min={0} step={0.1} hint={formatTime(beat.at)} onCommit={(at) => save("移动标记", { at })} />
          </Prop>
        </Section>
      </>
    );
  } else {
    body = (
      <>
        <Head icon={<Film size={15} />} kind="作品" title={meta.title} />
        <Section title="作品">
          <Prop label="标题">
            <TextField value={meta.title} onCommit={(title) => title && projectPatch("修改标题", { title })} />
          </Prop>
          <Prop label="说明">
            <TextField multiline value={meta.description} onCommit={(description) => projectPatch("修改说明", { description })} />
          </Prop>
          <Prop label="时长">
            <NumberField
              value={meta.duration}
              unit="秒"
              min={0.1}
              max={3600}
              step={1}
              hint={formatTime(meta.duration)}
              onCommit={(duration) => projectPatch("调整时长", { duration })}
            />
          </Prop>
          <Prop label="帧率">
            <NumberField value={meta.fps} unit="fps" min={12} max={60} step={1} onCommit={(fps) => projectPatch("修改帧率", { fps: Math.round(fps) })} />
          </Prop>
          <Prop label="经验库">
            <span className="prop-number">
              <span className="prop-static">{meta.experience || "不使用"}</span>
              <button className="btn small" onClick={() => showView("experience")}>
                选择…
              </button>
            </span>
          </Prop>
          <Prop label="画幅">
            <span className="prop-static">{meta.composition ? `${meta.composition.width}×${meta.composition.height}` : "1920×1080"}（让 AI 修改）</span>
          </Prop>
        </Section>
        <p className="view-hint">在时间轴上选中图层、音频片段、音轨、字幕或标记，这里会显示它的属性。所有修改都可以用 Ctrl+Z 撤销。</p>
      </>
    );
  }

  return (
    <div className="view">
      <ViewHeader title="属性" />
      {readOnly && <p className="view-hint">作品已发布，属性只能查看。</p>}
      <fieldset className="props props-fieldset" disabled={readOnly}>
        {body}
      </fieldset>
    </div>
  );
}

const sourceLabel = (layer: VisualClip) =>
  layer.source.kind === "scene"
    ? `代码场景 ${layer.source.module}`
    : layer.source.kind === "color"
      ? `纯色 ${layer.source.color}`
      : `${{ image: "图片", video: "视频", lottie: "Lottie", sequence: "序列帧" }[layer.source.kind] ?? layer.source.kind} ${(layer.source.src ?? "").replace(/^films\/[^/]+\//, "")}`;

function Head({ icon, kind, title, onSeek, onAsk }: { icon: ReactNode; kind: string; title: string; onSeek?: () => void; onAsk?: () => void }) {
  return (
    <div className="props-head">
      {icon}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="faint small-text">{kind}</div>
        <strong className="ellipsis" title={title}>
          {title}
        </strong>
      </div>
      {onSeek && (
        <button className="icon-btn" title="播放头跳到这里" onClick={onSeek}>
          <Crosshair size={14} />
        </button>
      )}
      {onAsk && (
        <button className="icon-btn" title="让 AI 修改这里" onClick={onAsk}>
          <Sparkles size={14} />
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="props-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">{label}</span>
      <span className="prop-control">{children}</span>
    </div>
  );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Saved on Enter or when leaving the field (one undo step); Escape restores. Empty → null when `placeholder` allows it. */
function NumberField({
  value,
  onCommit,
  unit,
  min,
  max,
  step = 1,
  scale = 1,
  hint,
  placeholder,
}: {
  value: number | null;
  onCommit: (value: number) => unknown;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  hint?: string;
  placeholder?: string;
}) {
  const shown = value === null ? "" : String(round(value * scale));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    if (draft.trim() === "") {
      if (placeholder !== undefined && value !== null) (onCommit as (value: number | null) => unknown)(null);
      else setDraft(shown);
      return;
    }
    let next = Number(draft);
    if (!Number.isFinite(next)) return setDraft(shown);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(round(next)));
    if (value === null || Math.abs(next / scale - value) > 1e-9) onCommit(round(next / scale));
  };
  return (
    <span className="prop-number">
      <input
        className="input"
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(shown);
            requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
          }
        }}
      />
      {unit && <span className="faint">{unit}</span>}
      {hint && <span className="faint small-text prop-hint">{hint}</span>}
    </span>
  );
}

/** A transform value: a number, or keyframes (animated by the AI or code) that can be replaced by a fixed value. */
function AnimatedField({
  value,
  fallback,
  onCommit,
  ...rest
}: {
  value: Animated;
  fallback: number;
  onCommit: (value: number) => unknown;
  unit?: string;
  scale?: number;
  step?: number;
  min?: number;
  max?: number;
}) {
  if (Array.isArray(value))
    return (
      <span className="prop-number">
        <span className="prop-static">关键帧动画（{value.length} 个）</span>
        <button className="btn small" title="去掉动画，改为第一个关键帧的值" onClick={() => onCommit(value[0]?.value ?? fallback)}>
          改为固定值
        </button>
      </span>
    );
  return <NumberField value={value ?? fallback} onCommit={onCommit} {...rest} />;
}

function TextField({
  value,
  onCommit,
  multiline,
  placeholder,
}: {
  value: string;
  onCommit: (value: string) => unknown;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft.trim() ? draft : "");
  const common = {
    value: draft,
    placeholder,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Escape") setDraft(value);
      // Enter saves a single line; Ctrl+Enter saves multi-line text.
      if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
  };
  return multiline ? <textarea className="textarea" rows={3} {...common} /> : <input className="input" {...common} />;
}

function Select({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => unknown }) {
  return (
    <select className="select" value={value} onChange={(event) => event.target.value !== value && onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => unknown }) {
  return (
    <span className="prop-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </span>
  );
}

/** dB fader with live preview of an audio clip (`previewId`) while dragging. */
function Volume({ gain, onCommit, previewId }: { gain: number; onCommit: (gain: number) => unknown; previewId?: string }) {
  const { stage } = useWorkbench();
  const [shown, setShown] = useState(gain);
  useEffect(() => setShown(gain), [gain]);
  return (
    <span className="prop-number">
      <VolumeSlider
        gain={gain}
        onPreview={(next) => {
          setShown(next);
          try {
            if (previewId) stage.api?.setTrack?.(previewId, { gain: Math.min(4, next) });
          } catch {
            // Preview only.
          }
        }}
        onCommit={(next) => void onCommit(next)}
      />
      <span className="mono faint">{formatDb(shown)}</span>
    </span>
  );
}
