import { useEffect, useRef, useState } from "react";
import { Mic, Play, Square, Music, Volume2, VolumeX, Wand2, Settings2 } from "lucide-react";
import { api, formatTime, workPath } from "../lib/api";
import { useAction } from "../lib/ui";
import type { AudioDocument } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { RecordButton } from "../workbench/RecordButton";
import { ViewHeader } from "./ViewHeader";

interface Voice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
}
interface Provider {
  id: string;
  name: string;
  ready: boolean;
  detail?: string;
}

export function AudioView() {
  const { work, reload, readOnly } = useWorkbench();
  const doc = work.meta?.audioDocument as AudioDocument | undefined;
  const [run] = useAction();
  const base = workPath(work.repo, work.id);
  const update = (collection: "tracks" | "clips", value: unknown) =>
    run(async () => {
      await api(`${base}/audio`, { body: { operations: [{ op: "put", collection, value }] } });
      await reload();
    });
  return (
    <div className="view">
      <ViewHeader title="音频与配音" />
      {readOnly && <p className="view-hint">作品已发布，不能再录音、配音或修改音轨。</p>}
      {/* A published work: every control below is disabled at once. */}
      <fieldset className="props-fieldset" disabled={readOnly}>
      <section className="view-section">
        <h3>
          <Mic size={14} /> 录音
        </h3>
        <p className="view-hint">把播放头放到要开始的位置，点麦克风后作品会同时播放，边看边录；停止后录音自动放到「录音」音轨。建议戴耳机。</p>
        <div className="record-row">
          <RecordButton />
          <span className="muted">从播放头开始录音</span>
        </div>
      </section>
      <SpeechSection />
      <section className="view-section">
        <h3>
          <Music size={14} /> 音轨
        </h3>
        {!doc && (
          <p className="view-hint">
还没有音频。录音、配音或在素材中把音频放到音轨。
          </p>
        )}
        {doc?.tracks.map((track) => (
          <div className="track-row" key={track.id}>
            <button
              className={`icon-btn ${track.muted ? "active" : ""}`}
              title={track.muted ? "取消静音" : "静音"}
              onClick={() => update("tracks", { ...track, muted: !track.muted })}
            >
              {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <span className="ellipsis grow">{track.name}</span>
            <span className="faint small-text">{doc.clips.filter((clip) => clip.track === track.id).length} 段</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              defaultValue={track.gain}
              title={`音量 ${Math.round(track.gain * 100)}%`}
              onPointerUp={(event) => update("tracks", { ...track, gain: Number((event.target as HTMLInputElement).value) })}
              onKeyUp={(event) => update("tracks", { ...track, gain: Number((event.target as HTMLInputElement).value) })}
            />
          </div>
        ))}
      </section>
      </fieldset>
    </div>
  );
}

function SpeechSection() {
  const { work, stage, reload, openSettings } = useWorkbench();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState("");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState("");
  const [text, setText] = useState("");
  const [rate, setRate] = useState(1);
  const [result, setResult] = useState<{ url: string; duration: number; path: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [run, busy] = useAction();
  const base = workPath(work.repo, work.id);

  useEffect(() => {
    void api<{ providers: Provider[]; defaultProvider: string }>("/api/speech/providers").then((data) => {
      setProviders(data.providers);
      setProvider(data.providers.find((item) => item.id === data.defaultProvider && item.ready)?.id ?? data.providers.find((item) => item.ready)?.id ?? "");
    });
  }, []);
  useEffect(() => {
    if (!provider) return;
    setVoices([]);
    void api<Voice[]>(`/api/speech/voices?provider=${encodeURIComponent(provider)}`).then(
      (list) => {
        setVoices(list);
        setVoice(list.find((item) => /zh-CN|zh/i.test(item.language || item.id))?.id ?? list[0]?.id ?? "");
      },
      () => setVoices([]),
    );
  }, [provider]);

  const generate = () =>
    run(async () => {
      const created = await api<{ url: string; duration: number; path: string }>(`${base}/speech`, { body: { text, provider, voice, rate } });
      setResult(created);
      const player = new Audio(`${work.preview.assetBase}${created.url}`);
      audio.current?.pause();
      audio.current = player;
      player.onended = () => setPlaying(false);
      setPlaying(true);
      await player.play();
    });
  const place = () =>
    run(async () => {
      if (!result) return;
      await api(`${base}/audio/place`, {
        body: { src: result.url, start: stage.playback.get().time, duration: result.duration, track: "配音", name: text.slice(0, 20) },
      });
      await reload();
      setResult(null);
    }, "已放到「配音」音轨");

  return (
    <section className="view-section">
      <h3>
        <Wand2 size={14} /> 配音（文字转语音）
      </h3>
      {!providers.some((item) => item.ready) ? (
        <p className="view-hint">
          还没有可用的语音引擎。
          <button className="link-btn" onClick={() => openSettings("speech")}>
            在 设置 → 语音 中安装模型或配置服务
          </button>
          。
        </p>
      ) : (
        <>
          <textarea className="textarea" rows={4} placeholder="输入要配音的文字" value={text} onChange={(event) => setText(event.target.value)} />
          <div className="speech-controls">
            <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.ready}>
                  {item.name}
                  {item.ready ? "" : "（未就绪）"}
                </option>
              ))}
            </select>
            <select className="select" value={voice} onChange={(event) => setVoice(event.target.value)}>
              {voices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <label className="row small-text muted" title="语速">
              <Settings2 size={13} />
              <input type="range" min={0.5} max={2} step={0.05} value={rate} onChange={(event) => setRate(Number(event.target.value))} />
              {rate.toFixed(2)}×
            </label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!text.trim() || !voice || busy} onClick={generate}>
              {busy ? <span className="spinner" /> : <Play size={13} />} 生成并试听
            </button>
            {result && (
              <>
                <button
                  className="icon-btn"
                  title={playing ? "停止" : "再听一次"}
                  onClick={() => {
                    if (playing) {
                      audio.current?.pause();
                      setPlaying(false);
                    } else {
                      audio.current!.currentTime = 0;
                      void audio.current?.play();
                      setPlaying(true);
                    }
                  }}
                >
                  {playing ? <Square size={13} /> : <Play size={13} />}
                </button>
                <button className="btn" onClick={place}>
                  放到播放头 {formatTime(stage.playback.get().time, false)}
                </button>
                <span className="faint small-text">{result.duration.toFixed(1)} 秒</span>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
