import { useEffect, useRef, useState, type RefObject } from "react";
import { Mic, Square } from "lucide-react";
import { api, formatBytes, formatTime, useServerEvent } from "../lib/api";
import { useConfirm, useToast } from "../lib/ui";
import { joinSpoken, placeSpoken } from "./spoken";

export type DictationState = "idle" | "starting" | "listening" | "finishing";

// Hands the microphone's samples to the page in 0.1 s blocks of 16-bit PCM, with their loudness.
const WORKLET = `
class FrameDictation extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.reset();
  }
  reset() {
    this.block = new Int16Array(this.size);
    this.length = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel)
      for (let index = 0; index < channel.length; index++) {
        const value = Math.max(-1, Math.min(1, channel[index]));
        this.block[this.length++] = value * 32767;
        this.energy += value * value;
        if (this.length === this.size) {
          this.port.postMessage({ pcm: this.block.buffer, level: Math.sqrt(this.energy / this.size) }, [this.block.buffer]);
          this.reset();
        }
      }
    return true;
  }
}
registerProcessor("frame-dictation", FrameDictation);
`;

interface Run {
  ws: WebSocket;
  /** The input as it was, with its selection: back to that when nothing is kept. */
  original: { text: string; from: number; to: number };
  before: string;
  after: string;
  finals: Map<number, string>;
  partial: { sentence: number; text: string } | null;
  /** Sends now, or once the socket is open. */
  send: (data: ArrayBuffer | string) => void;
  context?: AudioContext;
  stream?: MediaStream;
  listening: boolean;
  stopping: boolean;
  done: boolean;
}

export interface Dictation {
  state: DictationState;
  /** The input belongs to the dictation: read-only, Enter finishes, Esc cancels. */
  active: boolean;
  startedAt: number;
  start(): Promise<void>;
  /** Finish: what was said stays in the input, to be edited and sent by the user. */
  stop(): void;
  /** Throw away what was said. */
  cancel(): void;
  /** Called with the microphone's loudness (0–1) ten times a second. */
  meter: RefObject<((level: number) => void) | null>;
}

/**
 * Voice input for the chat: the microphone streams to the server (/api/speech/listen), which
 * sends back each sentence as it is recognized. The text goes in at the cursor and is never sent
 * by itself.
 */
export function useDictation({
  input,
  text,
  setText,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
}): Dictation {
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<DictationState>("idle");
  const [startedAt, setStartedAt] = useState(0);
  const run = useRef<Run | null>(null);
  const meter = useRef<((level: number) => void) | null>(null);
  const latestText = useRef(text);
  latestText.current = text;
  // A model download started from here: say when it is ready.
  const download = useRef<string | null>(null);

  useServerEvent((event) => {
    const task = event.type === "task" ? (event.task as { id: string; status: string; error?: string }) : null;
    if (!task || task.id !== download.current || task.status === "running") return;
    download.current = null;
    if (task.status === "done") toast("语音识别模型下载好了，点麦克风开始说话", "ok");
    else if (task.status === "failed") toast("下载语音识别模型失败：" + task.error, "error");
  });

  const show = (current: Run) => {
    const parts = [...current.finals.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    if (current.partial) parts.push(current.partial.text);
    const placed = placeSpoken(current.before, joinSpoken(parts), current.after);
    setText(placed.text);
    requestAnimationFrame(() => input.current?.setSelectionRange(placed.cursor, placed.cursor));
  };
  const releaseAudio = (current: Run) => {
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => {});
    current.stream = undefined;
    current.context = undefined;
    meter.current?.(0);
  };
  const finish = (current: Run, problem?: string) => {
    if (current.done) return;
    current.done = true;
    releaseAudio(current);
    if (current.ws.readyState <= WebSocket.OPEN) current.ws.close();
    if (run.current === current) run.current = null;
    if (current.finals.size || current.partial) show(current);
    else {
      const { text, from, to } = current.original;
      setText(text);
      requestAnimationFrame(() => input.current?.setSelectionRange(from, to));
    }
    setState("idle");
    if (problem) toast(problem, "error");
    input.current?.focus();
  };

  const offerModel = async (model: { id: string; name: string; size: number }) => {
    const ok = await confirm(
      `语音输入要先下载识别模型 ${model.name}（约 ${formatBytes(model.size)}），之后在服务器上离线识别。现在下载吗？也可以在 设置 → 语音 配置识别接口。`,
      { confirm: "下载" },
    );
    if (!ok) return;
    try {
      download.current = (await api<{ id: string }>(`/api/speech/models/${model.id}/install`, { method: "POST" }))?.id ?? null;
      toast("开始下载语音识别模型，下载好了会提示你", "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  const start = async () => {
    if (run.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined")
      return void toast("这个浏览器环境不能使用麦克风（需要 HTTPS 或 localhost）", "error");
    const element = input.current;
    const value = latestText.current;
    const from = element?.selectionStart ?? value.length;
    const to = element?.selectionEnd ?? value.length;
    // Created within the click: browsers only let a page start audio there.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      context = new AudioContext();
    }
    // Connects while the user is asked for the microphone: a missing engine shows right away.
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/speech/listen`);
    const queue: (ArrayBuffer | string)[] = [];
    const send = (data: ArrayBuffer | string) => (ws.readyState === WebSocket.OPEN ? ws.send(data) : queue.push(data));
    ws.onopen = () => queue.splice(0).forEach((data) => ws.send(data));
    const current: Run = {
      ws,
      original: { text: value, from, to },
      before: value.slice(0, from),
      after: value.slice(to),
      finals: new Map(),
      partial: null,
      send,
      context,
      listening: false,
      stopping: false,
      done: false,
    };
    run.current = current;
    setState("starting");
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "partial" && !current.finals.has(message.sentence)) {
        current.partial = message;
        show(current);
      } else if (message.type === "final") {
        current.finals.set(message.sentence, message.text);
        if (current.partial && current.partial.sentence <= message.sentence) current.partial = null;
        show(current);
      } else if (message.type === "done") finish(current);
      else if (message.type === "error") {
        finish(current, message.code === "NO_RECOGNIZER" ? undefined : message.message);
        if (message.code === "NO_RECOGNIZER") void offerModel(message.model);
      }
    };
    ws.onclose = () => finish(current, "语音识别的连接断开了");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      current.stream = stream;
      // Cancelled, or the server refused, while the user was asked.
      if (current.done) return releaseAudio(current);
      let source: MediaStreamAudioSourceNode;
      try {
        source = context.createMediaStreamSource(stream);
      } catch {
        // Firefox takes a microphone only at its own rate: record at that rate, the server converts it.
        void context.close();
        context = current.context = new AudioContext();
        source = context.createMediaStreamSource(stream);
      }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (current.done) return releaseAudio(current);
      send(JSON.stringify({ type: "start", rate: context.sampleRate }));
      const node = new AudioWorkletNode(context, "frame-dictation");
      node.port.onmessage = ({ data }) => {
        if (current.stopping || current.done) return;
        send(data.pcm);
        meter.current?.(data.level);
      };
      source.connect(node);
      node.connect(context.destination); // silent; keeps the node running in every browser
      if (context.state === "suspended") await context.resume();
      if (current.done) return;
      current.listening = true;
      setStartedAt(Date.now());
      setState("listening");
      // After the render that makes the input read-only: no on-screen keyboard.
      setTimeout(() => input.current?.focus(), 0);
    } catch (error) {
      finish(current, current.done ? undefined : "无法使用麦克风：" + (error as Error).message);
    }
  };

  const stop = () => {
    const current = run.current;
    if (!current || current.stopping) return;
    // The microphone is not on yet: nothing to keep.
    if (!current.listening) return cancel();
    current.stopping = true;
    releaseAudio(current);
    current.send(JSON.stringify({ type: "stop" }));
    setState("finishing");
    // A server that never answers must not keep the input locked.
    setTimeout(() => finish(current, current.done ? undefined : "语音识别没有响应，已保留识别到的文字"), 20000);
  };
  const cancel = () => {
    const current = run.current;
    if (!current) return;
    current.finals.clear();
    current.partial = null;
    finish(current);
  };

  useEffect(
    () => () => {
      const current = run.current;
      if (!current) return;
      current.done = true;
      releaseAudio(current);
      current.ws.close();
      run.current = null;
    },
    [],
  );

  return { state, active: state !== "idle", startedAt, start, stop, cancel, meter };
}

/** The microphone button of the chat input; while listening, a red stop button with the elapsed time. */
export function DictationButton({ dictation }: { dictation: Dictation }) {
  const button = useRef<HTMLButtonElement>(null);
  const [, tick] = useState(0);
  const { meter, state } = dictation;
  useEffect(() => {
    meter.current = (level) => button.current?.style.setProperty("--level", String(Math.min(1, level * 6)));
    return () => void (meter.current = null);
  }, [meter]);
  useEffect(() => {
    if (state !== "listening") return;
    const timer = setInterval(() => tick((count) => count + 1), 500);
    return () => clearInterval(timer);
  }, [state]);
  if (state === "listening")
    return (
      <button ref={button} className="dictate-btn" title="说完了（Enter）；Esc 取消" onClick={dictation.stop}>
        <Square size={9} fill="currentColor" /> {formatTime((Date.now() - dictation.startedAt) / 1000, false)}
      </button>
    );
  return (
    <button
      ref={button}
      className="icon-btn"
      title={state === "idle" ? "语音输入：说话转成文字，改好再发送" : state === "starting" ? "正在打开麦克风（点一下取消）" : "正在识别最后一句"}
      disabled={state === "finishing"}
      onClick={() => (state === "idle" ? void dictation.start() : dictation.cancel())}
    >
      {state === "idle" ? <Mic size={15} /> : <span className="spinner" />}
    </button>
  );
}
