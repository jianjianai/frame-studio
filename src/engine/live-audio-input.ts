/** Live microphone input stays in the trusted workbench; opaque previews receive bounded PCM only. */
export interface LiveAudioInputDevice {
  kind: "audioinput";
  deviceId: string;
  groupId: string;
  label: string;
}
export interface LiveAudioInputHandle {
  readonly node: AudioNode;
  readonly device: LiveAudioInputDevice;
  readonly state: "started" | "stopped";
  close(): void;
}
const INPUT_MESSAGE = "frame-live-audio-input";
const CAPACITY = 16384;
const MAX_CHUNK = 4096;
const MAX_FLIGHT = 4;
const processor = `
class FrameLiveAudioInput extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.ring = Array.from({length: this.channels}, () => new Float32Array(${CAPACITY}));
    this.read = 0; this.write = 0; this.markers = []; this.closed = false;
    this.port.onmessage = ({data}) => {
      if (data?.type === 'close') { this.closed = true; this.markers = []; return; }
      if (data?.type === 'flush' && !this.closed) { for(const marker of this.markers)this.port.postMessage({type:'ack',sequence:marker.sequence}); this.markers=[];this.read=0;this.write=0;return; }
      if (data?.type !== 'pcm' || this.closed) return;
      const frames = data.frames, buffers = data.buffers;
      if (!Number.isInteger(frames) || frames < 1 || frames > ${MAX_CHUNK} || !Array.isArray(buffers) || buffers.length < 1 || buffers.length > 2 || this.markers.length >= ${MAX_FLIGHT} || this.write - this.read + frames > ${CAPACITY}) {
        this.port.postMessage({type:'error'}); return;
      }
      const input = buffers.map(buffer => new Float32Array(buffer));
      for (let c = 0; c < this.channels; c++) {
        const source = input[c % input.length], ring = this.ring[c];
        for (let i = 0; i < frames; i++) ring[(this.write + i) % ${CAPACITY}] = source[i];
      }
      this.write += frames;
      this.markers.push({end:this.write, sequence:data.sequence});
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    for (const channel of output) channel.fill(0);
    if (this.closed) return false;
    const length = Math.min(output[0]?.length || 128, this.write - this.read);
    for (let c = 0; c < output.length; c++) {
      const ring = this.ring[c % this.channels];
      for (let i = 0; i < length; i++) output[c][i] = ring[(this.read + i) % ${CAPACITY}];
    }
    this.read += length;
    while (this.markers.length && this.markers[0].end <= this.read) this.port.postMessage({type:'ack', sequence:this.markers.shift().sequence});
    if (this.read === this.write) { this.read = 0; this.write = 0; }
    return true;
  }
}
registerProcessor('frame-live-audio-input-v1', FrameLiveAudioInput);
`;
const modules = new WeakMap<BaseAudioContext, Promise<void>>();
function inputError(message: string, name = "NotReadableError") {
  return new DOMException(message, name);
}
function validateDevice(device?: string | number) {
  if (
    device !== undefined &&
    !(
      (typeof device === "string" &&
        device.length > 0 &&
        device.length <= 200) ||
      (Number.isInteger(device) && Number(device) >= 0 && Number(device) <= 63)
    )
  )
    throw TypeError(
      "Audio input device must be a label/deviceId or an index from 0 to 63",
    );
}
function nativeInputAvailable() {
  return (
    typeof window !== "undefined" &&
    window.origin !== "null" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}
export function liveAudioInputSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    (nativeInputAvailable() ||
      (window.parent !== window && typeof AudioWorkletNode !== "undefined"))
  );
}
function deviceInfo(value: unknown): LiveAudioInputDevice {
  const data = value as Partial<LiveAudioInputDevice> | undefined;
  if (
    !data ||
    data.kind !== "audioinput" ||
    [data.deviceId, data.groupId, data.label].some(
      (v) => typeof v !== "string" || v.length > 512,
    )
  )
    throw inputError("Workbench returned invalid audio input metadata");
  return {
    kind: "audioinput",
    deviceId: data.deviceId!,
    groupId: data.groupId!,
    label: data.label!,
  };
}
function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  if (signal?.aborted) {
    void work.then((value) => disposeLate?.(value)).catch(() => {});
    return Promise.reject(
      signal.reason ?? inputError("Audio input cancelled", "AbortError"),
    );
  }
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(
        signal.reason ?? inputError("Audio input cancelled", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    work
      .then((value) => {
        if (cancelled) disposeLate?.(value);
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
async function prepareInputProcessor(context: BaseAudioContext) {
  if (!context.audioWorklet)
    throw inputError(
      "Live audio input requires AudioWorklet in a secure browser",
      "NotSupportedError",
    );
  let job = modules.get(context);
  if (!job) {
    const url = URL.createObjectURL(
      new Blob([processor], { type: "text/javascript" }),
    );
    job = context.audioWorklet
      .addModule(url)
      .finally(() => URL.revokeObjectURL(url));
    modules.set(context, job);
    void job.catch(() => {
      if (modules.get(context) === job) modules.delete(context);
    });
  }
  await job;
}
function requestId() {
  return crypto.randomUUID();
}
function nativeDevice(stream: MediaStream): LiveAudioInputDevice {
  const track = stream.getAudioTracks()[0],
    settings = track.getSettings();
  return {
    kind: "audioinput",
    deviceId: settings.deviceId ?? "",
    groupId: settings.groupId ?? "",
    label: track.label,
  };
}
async function nativeInput(
  context: AudioContext,
  device: string | number | undefined,
  channels: 1 | 2,
  signal?: AbortSignal,
): Promise<LiveAudioInputHandle> {
  let chosen: MediaDeviceInfo | undefined;
  if (device !== undefined) {
    const devices = (
      await abortable(navigator.mediaDevices.enumerateDevices(), signal)
    ).filter((row) => row.kind === "audioinput");
    chosen =
      typeof device === "number"
        ? devices[device]
        : devices.find(
            (row) => row.deviceId === device || row.label === device,
          );
    if (!chosen)
      throw inputError("No matching audio input device", "NotFoundError");
  }
  signal?.throwIfAborted();
  const stream = await abortable(
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: context.sampleRate,
        channelCount: channels,
        ...(chosen ? { deviceId: { exact: chosen.deviceId } } : {}),
      },
    }),
    signal,
    (stream) => stream.getTracks().forEach((track) => track.stop()),
  );
  try {
    signal?.throwIfAborted();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  let node: MediaStreamAudioSourceNode | undefined,
    metadata: LiveAudioInputDevice;
  try {
    if (context.state === "closed")
      throw inputError(
        "Audio context closed while opening live input",
        "InvalidStateError",
      );
    node = context.createMediaStreamSource(stream);
    metadata = nativeDevice(stream);
  } catch (error) {
    try {
      node?.disconnect();
    } catch {}
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  let closed = false;
  const contextClosed = () => {
    if (context.state === "closed") close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    context.removeEventListener("statechange", contextClosed);
    node.disconnect();
    stream.getTracks().forEach((track) => track.stop());
  };
  signal?.addEventListener("abort", close, { once: true });
  context.addEventListener("statechange", contextClosed);
  return {
    node,
    device: metadata,
    get state() {
      return !closed && stream.active ? "started" : "stopped";
    },
    close,
  };
}
/** Open live input. A Studio preview displays a trusted Allow/Deny prompt; no microphone permission is delegated to the sandbox. */
export async function createLiveAudioInput(
  context: BaseAudioContext,
  options: {
    device?: string | number;
    channels?: 1 | 2;
    signal?: AbortSignal;
  } = {},
): Promise<LiveAudioInputHandle> {
  const { device, signal } = options,
    channels = options.channels ?? 2;
  validateDevice(device);
  signal?.throwIfAborted();
  if (!("createMediaStreamSource" in context))
    throw inputError(
      "Live input cannot be rendered offline or reconstructed after a seek; record it as a project audio asset first",
      "NotSupportedError",
    );
  if (!liveAudioInputSupported())
    throw inputError(
      "Live input requires a secure browser and the trusted Studio audio input broker",
      "NotSupportedError",
    );
  if (channels !== 1 && channels !== 2)
    throw TypeError("Audio input channels must be 1 or 2");
  if (nativeInputAvailable())
    return nativeInput(context as AudioContext, device, channels, signal);
  await abortable(prepareInputProcessor(context), signal);
  signal?.throwIfAborted();
  const node = new AudioWorkletNode(context, "frame-live-audio-input-v1", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { channels },
  });
  // Pull input even when connected only to a Meter or Recorder. This branch is always silent.
  const keepAlive = context.createGain();
  keepAlive.gain.value = 0;
  node.connect(keepAlive);
  keepAlive.connect(context.destination);
  const channel = new MessageChannel(),
    port = channel.port1;
  let closed = false,
    started = false,
    metadata: LiveAudioInputDevice | undefined,
    sequence = -1;
  let rejectOpening: (error: unknown) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const contextClosed = () => {
    if (context.state === "closed") close();
    else node.port.postMessage({ type: "flush" });
  };
  const close = (error = inputError("Audio input closed", "AbortError")) => {
    if (closed) return;
    closed = true;
    started = false;
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
    context.removeEventListener("statechange", contextClosed);
    try {
      port.postMessage({ type: "close" });
    } catch {}
    port.close();
    channel.port2.close();
    node.port.postMessage({ type: "close" });
    node.port.close();
    node.disconnect();
    keepAlive.disconnect();
    rejectOpening(error);
  };
  const abort = () =>
    close(signal?.reason ?? inputError("Audio input cancelled", "AbortError"));
  const opening = new Promise<void>((resolve, reject) => {
    rejectOpening = reject;
    timer = setTimeout(
      () =>
        close(
          inputError(
            "Trusted Studio audio input broker is unavailable; open this preview inside the workbench",
            "NotSupportedError",
          ),
        ),
      4000,
    );
    port.onmessage = ({ data }) => {
      if (closed) return;
      try {
        if (data?.type === "ack") {
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              close(
                inputError(
                  "Audio input approval timed out; use the workbench Allow button and try again",
                  "TimeoutError",
                ),
              ),
            90000,
          );
        } else if (data?.type === "ready") {
          if (
            started ||
            data.sampleRate !== context.sampleRate ||
            ![1, 2].includes(data.channels) ||
            !Number.isInteger(data.chunkFrames) ||
            data.chunkFrames < 1 ||
            data.chunkFrames > MAX_CHUNK ||
            !Number.isInteger(data.maxInFlight) ||
            data.maxInFlight < 1 ||
            data.maxInFlight > MAX_FLIGHT
          )
            throw inputError(
              "Workbench returned unsupported audio input parameters",
            );
          metadata = deviceInfo(data.device);
          clearTimeout(timer);
          started = true;
          heartbeat = setInterval(() => {
            if (!closed)
              try {
                port.postMessage({ type: "ping" });
              } catch {
                close();
              }
          }, 1000);
          resolve();
        } else if (data?.type === "pcm") {
          if (
            !started ||
            !Number.isInteger(data.sequence) ||
            data.sequence <= sequence ||
            !Number.isInteger(data.frames) ||
            data.frames < 1 ||
            data.frames > MAX_CHUNK ||
            ![1, 2].includes(data.channels) ||
            !Array.isArray(data.buffers) ||
            data.buffers.length !== data.channels ||
            data.buffers.some(
              (buffer: unknown) =>
                !(buffer instanceof ArrayBuffer) ||
                buffer.byteLength !== data.frames * 4,
            )
          )
            throw inputError("Workbench returned an invalid PCM input chunk");
          sequence = data.sequence;
          if (context.state !== "running")
            port.postMessage({ type: "ack", sequence: data.sequence });
          else node.port.postMessage(data, data.buffers);
        } else if (data?.type === "error")
          close(
            inputError(
              String(data.message || "Audio input denied"),
              String(data.code || "NotAllowedError"),
            ),
          );
        else if (data?.type === "ended")
          close(
            inputError("Audio input device disconnected", "NotReadableError"),
          );
      } catch (error) {
        close(
          error instanceof DOMException ? error : inputError(String(error)),
        );
      }
    };
  });
  node.port.onmessage = ({ data }) => {
    if (closed) return;
    if (data?.type === "ack")
      port.postMessage({ type: "ack", sequence: data.sequence });
    else if (data?.type === "error")
      close(inputError("Audio input exceeded its bounded PCM queue"));
  };
  node.onprocessorerror = () =>
    close(inputError("Live audio input processor failed"));
  signal?.addEventListener("abort", abort, { once: true });
  context.addEventListener("statechange", contextClosed);
  try {
    parent.postMessage(
      {
        type: INPUT_MESSAGE,
        op: "open",
        requestId: requestId(),
        sampleRate: context.sampleRate,
        channels,
        ...(device !== undefined ? { device } : {}),
      },
      "*",
      [channel.port2],
    );
  } catch (error) {
    close(
      inputError(
        "Unable to contact trusted Studio audio input broker: " + String(error),
        "NotSupportedError",
      ),
    );
  }
  await opening;
  return {
    node,
    device: metadata!,
    get state() {
      return started && !closed ? "started" : "stopped";
    },
    close,
  };
}
/** Studio device enumeration requires the same explicit trusted approval as opening an input. */
export async function enumerateLiveAudioInputs(
  signal?: AbortSignal,
): Promise<MediaDeviceInfo[]> {
  signal?.throwIfAborted();
  if (!liveAudioInputSupported())
    throw inputError("Live audio input is unavailable", "NotSupportedError");
  if (nativeInputAvailable())
    return (await navigator.mediaDevices.enumerateDevices()).filter(
      (row) => row.kind === "audioinput",
    );
  const channel = new MessageChannel(),
    port = channel.port1;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        port.postMessage({ type: "close" });
      } catch {}
      port.close();
      channel.port2.close();
    };
    const fail = (error: unknown) => {
      close();
      reject(error);
    };
    const abort = () =>
      fail(
        signal?.reason ??
          inputError("Device enumeration cancelled", "AbortError"),
      );
    timer = setTimeout(
      () =>
        fail(
          inputError(
            "Trusted audio input broker is unavailable",
            "NotSupportedError",
          ),
        ),
      4000,
    );
    port.onmessage = ({ data }) => {
      if (data?.type === "ack") {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            fail(inputError("Audio device approval timed out", "TimeoutError")),
          90000,
        );
      } else if (data?.type === "error")
        fail(
          inputError(
            String(data.message || "Audio device access denied"),
            String(data.code || "NotAllowedError"),
          ),
        );
      else if (data?.type === "devices") {
        try {
          if (!Array.isArray(data.devices) || data.devices.length > 64)
            throw inputError("Invalid audio device list");
          const devices = data.devices.map((value: unknown) => {
            const info = deviceInfo(value);
            return Object.freeze({
              ...info,
              toJSON: () => ({ ...info }),
            }) as MediaDeviceInfo;
          });
          close();
          resolve(devices);
        } catch (error) {
          fail(error);
        }
      } else if (data?.type === "ended")
        fail(inputError("Audio device request ended", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      parent.postMessage(
        { type: INPUT_MESSAGE, op: "enumerate", requestId: requestId() },
        "*",
        [channel.port2],
      );
    } catch (error) {
      fail(
        inputError(
          "Unable to contact trusted Studio audio input broker: " +
            String(error),
          "NotSupportedError",
        ),
      );
    }
  });
}
