const TYPE = "frame-live-audio-input";
const MAX_LEASES = 8,
  MAX_PENDING = 8,
  MAX_IN_FLIGHT = 4,
  CHUNK_FRAMES = 2048;
const CAPTURE_SOURCE = `
class FrameLiveInput extends AudioWorkletProcessor {
  constructor() { super(); this.offset = 0; this.credits=4;this.port.onmessage=({data})=>{if(data?.credit===1)this.credits=Math.min(4,this.credits+1)}; this.rows = [new Float32Array(1024),new Float32Array(1024)]; }
  process(inputs,outputs) {
    for(const output of outputs)for(const row of output)row.fill(0);
    const input=inputs[0]; if(!input?.[0])return true;
    for(let i=0;i<input[0].length;i++){
      this.rows[0][this.offset]=input[0][i];
      this.rows[1][this.offset]=input[1]?.[i]??input[0][i];
      if(++this.offset===1024){
        if(this.credits>0){this.credits--;const buffers=this.rows.map(row=>row.buffer);
        this.port.postMessage({buffers},buffers);
        this.rows=[new Float32Array(1024),new Float32Array(1024)];}this.offset=0;
      }
    }
    return true;
  }
}
registerProcessor("frame-live-input",FrameLiveInput);
`;
const errorValue = (code, message) =>
  Object.assign(new Error(message), { name: code });
const metadata = (device) => ({
  deviceId: String(device?.deviceId ?? ""),
  groupId: String(device?.groupId ?? ""),
  label: String(device?.label ?? ""),
  kind: "audioinput",
});

/** Trusted Studio owns permission and hardware; the opaque player receives bounded PCM only. */
export function liveAudioInputBridge(iframe, previewUrl, onState = () => {}) {
  const expectedUrl = new URL(previewUrl, location.href),
    base = new URL("./", expectedUrl),
    element = iframe.current,
    actualUrl = element ? new URL(element.src, location.href) : null;
  if (
    !element ||
    actualUrl.origin !== expectedUrl.origin ||
    actualUrl.pathname !== expectedUrl.pathname ||
    base.origin !== location.origin ||
    !/^\/preview-live\/[^/]+\/$/.test(base.pathname)
  )
    return { allow() {}, deny() {}, stop() {}, reallow() {}, dispose() {} };
  const windowProxy = element.contentWindow,
    originalSrc = element.getAttribute("src");
  const requests = new Map();
  let disposed = false,
    capture,
    creatingCapture,
    captureTask,
    lastError = "",
    denied = false,
    enumerationGrant = false;
  const inputGrants = new Set();
  const permissionKey = (row) =>
    JSON.stringify([row.device ?? null, row.sampleRate, row.channels]);
  const connected = () =>
    !disposed &&
    iframe.current === element &&
    element.isConnected &&
    element.contentWindow === windowProxy &&
    element.getAttribute("src") === originalSrc;
  const state = () => {
    if (disposed) return;
    onState({
      requests: [...requests.values()]
        .filter((row) => row.stage === "pending" || row.stage === "opening")
        .map((row) => ({
          requestId: row.id,
          op: row.op,
          stage: row.stage,
          sampleRate: row.sampleRate,
          channels: row.channels,
          device: row.device,
          label: row.op === "enumerate" ? "读取麦克风设备列表" : "使用麦克风",
        })),
      active: [...requests.values()]
        .filter((row) => row.stage === "active")
        .map((row) => ({
          requestId: row.id,
          device: row.openedDevice,
          sampleRate: row.sampleRate,
          channels: row.channels,
        })),
      capturing: !!capture,
      granted: inputGrants.size > 0,
      enumerationGranted: enumerationGrant,
      denied,
      error: lastError,
    });
  };
  const post = (row, data, transfer = []) => {
    if (row.closed || !connected()) return false;
    try {
      row.port.postMessage(data, transfer);
      return true;
    } catch {
      return false;
    }
  };
  const authorized = () =>
    [...requests.values()].some(
      (row) =>
        row.op === "open" &&
        ["opening", "active"].includes(row.stage) &&
        !row.closed,
    );
  const releaseCapture = (current = capture) => {
    if (!current) return;
    if (capture === current) capture = undefined;
    if (creatingCapture === current) creatingCapture = undefined;
    current.stream?.getTracks().forEach((track) => {
      track.onended = null;
      if (track.readyState !== "ended") track.stop();
    });
    if (current.released) return;
    current.released = true;
    current.node?.disconnect();
    current.source?.disconnect();
    if (current.node) current.node.port.onmessage = null;
    void current.context?.close().catch(() => {});
    if (current.url) URL.revokeObjectURL(current.url);
  };
  const finish = (row, packet) => {
    if (row.closed) return;
    if (packet) post(row, packet);
    row.closed = true;
    clearTimeout(row.timer);
    requests.delete(row.id);
    row.inFlight.clear();
    row.output = [];
    row.port.onmessage = null;
    row.port.onmessageerror = null;
    row.port.close();
    if (!authorized()) {
      releaseCapture();
      releaseCapture(creatingCapture);
      captureTask = undefined;
    }
    state();
  };
  const fail = (row, error) => {
    const message = error.message || "麦克风不可用",
      code = error.name || "NotReadableError";
    if (code !== "AbortError") lastError = message;
    finish(row, { type: "error", code, message });
  };
  const stop = (message = "本预览已停止使用麦克风") => {
    inputGrants.clear();
    enumerationGrant = false;
    denied = true;
    for (const row of [...requests.values()])
      finish(
        row,
        row.stage === "active"
          ? { type: "ended", message }
          : { type: "error", code: "AbortError", message },
      );
    releaseCapture();
    releaseCapture(creatingCapture);
    captureTask = undefined;
    state();
  };
  const devices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices)
      throw errorValue(
        "NotSupportedError",
        "当前浏览器不支持麦克风设备查询，请使用 HTTPS 工作台",
      );
    return (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput")
      .slice(0, 64)
      .map(metadata);
  };
  const choose = (list, selection) => {
    if (selection === undefined) return undefined;
    const device =
      typeof selection === "number"
        ? list[selection]
        : list.find(
            (device) =>
              device.deviceId === selection || device.label === selection,
          );
    if (!device)
      throw errorValue(
        "NotFoundError",
        "未找到请求的麦克风；请重新查询设备或使用默认麦克风",
      );
    return device;
  };
  const ship = (row) => {
    if (row.outputFrames === 0) return;
    if (row.inFlight.size < MAX_IN_FLIGHT) {
      const buffers = row.output.map(
          (values) => Float32Array.from(values).buffer,
        ),
        sequence = row.sequence++;
      row.inFlight.set(sequence, performance.now());
      if (
        !post(
          row,
          {
            type: "pcm",
            sequence,
            frames: row.outputFrames,
            channels: row.channels,
            buffers,
          },
          buffers,
        )
      ) {
        finish(row);
        return;
      }
    }
    // Backpressure drops newly captured chunks instead of accumulating microphone audio.
    row.output = Array.from({ length: row.channels }, () => []);
    row.outputFrames = 0;
  };
  const distribute = (buffers) => {
    if (!connected()) {
      stop("预览页面已更换，麦克风已停止");
      return;
    }
    const input = buffers.map((buffer) => new Float32Array(buffer));
    if (!input[0]?.length || input[0].length > 4096) return;
    for (const row of [...requests.values()]) {
      if (row.stage !== "active" || row.closed) continue;
      const step = capture.context.sampleRate / row.sampleRate;
      // One previous input sample permits continuous interpolation at chunk boundaries.
      const last = row.previous ?? input.map((samples) => samples[0]);
      const length = input[0].length;
      while (row.position < length - 1) {
        const at = Math.floor(row.position),
          mix = row.position - at;
        for (let channel = 0; channel < row.channels; channel++) {
          const source = input[Math.min(channel, input.length - 1)];
          const a = at < 0 ? last[channel] : source[at],
            b = source[at + 1];
          row.output[channel].push(a + (b - a) * mix);
        }
        row.outputFrames++;
        row.position += step;
        if (row.outputFrames === CHUNK_FRAMES) ship(row);
        if (row.closed) break;
      }
      row.position -= length;
      row.previous = input
        .slice(0, row.channels)
        .map((samples) => samples.at(-1));
      // Keep realtime input latency below one capture block, even at low sample rates.
      if (!row.closed) ship(row);
    }
  };
  const createCapture = async (row) => {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio || !navigator.mediaDevices?.getUserMedia)
      throw errorValue(
        "NotSupportedError",
        "当前浏览器不支持麦克风，请使用 HTTPS 工作台",
      );
    const current = {
      context: new Audio({ sampleRate: row.sampleRate }),
      stream: null,
      node: null,
      source: null,
      url: null,
      device: null,
    };
    creatingCapture = current;
    const check = () => {
      if (current.released || !connected() || !authorized())
        throw errorValue("AbortError", "麦克风请求已取消");
    };
    try {
      // Called directly by the trusted Allow button; no child can trigger this path.
      const resumed = current.context.resume();
      let list = await devices();
      check();
      let selected;
      try {
        selected = choose(list, row.device);
      } catch (error) {
        if (
          typeof row.device !== "string" ||
          list.some((device) => device.label)
        )
          throw error;
      }
      current.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: row.sampleRate },
          channelCount: { ideal: 2 },
          ...(selected?.deviceId
            ? { deviceId: { exact: selected.deviceId } }
            : {}),
        },
        video: false,
      });
      check();
      if (row.device !== undefined && !selected) {
        list = await devices();
        check();
        selected = choose(list, row.device);
        const actual = current.stream
          .getAudioTracks()[0]
          ?.getSettings?.().deviceId;
        if (selected.deviceId !== actual) {
          current.stream.getTracks().forEach((track) => track.stop());
          current.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: selected.deviceId },
              channelCount: { ideal: 2 },
              sampleRate: { ideal: row.sampleRate },
            },
            video: false,
          });
          check();
        }
      }
      await resumed;
      check();
      const track = current.stream.getAudioTracks()[0];
      if (!track)
        throw errorValue("NotReadableError", "浏览器没有提供音频输入轨道");
      const setting = track.getSettings?.() ?? {};
      list = await devices();
      check();
      current.device = metadata(
        list.find((device) => device.deviceId === setting.deviceId) || {
          ...setting,
          label: track.label,
        },
      );
      current.url = URL.createObjectURL(
        new Blob([CAPTURE_SOURCE], { type: "text/javascript" }),
      );
      await current.context.audioWorklet.addModule(current.url);
      check();
      current.node = new AudioWorkletNode(current.context, "frame-live-input", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      current.source = current.context.createMediaStreamSource(current.stream);
      current.source.connect(current.node);
      current.node.connect(current.context.destination);
      capture = current;
      if (creatingCapture === current) creatingCapture = undefined;
      current.node.port.onmessage = ({ data }) => {
        if (capture === current && Array.isArray(data?.buffers)) {
          try {
            distribute(data.buffers);
          } finally {
            current.node.port.postMessage({ credit: 1 });
          }
        }
      };
      track.onended = () => {
        if (capture === current) {
          lastError = "麦克风已断开，重新调用 open() 后可再次授权";
          stop(lastError);
        }
      };
      return current;
    } catch (error) {
      releaseCapture(current);
      throw error;
    }
  };
  const allow = async (id, event) => {
    const row = requests.get(id);
    if (!row || row.stage !== "pending" || !connected()) return;
    const reused =
      row.op === "enumerate"
        ? enumerationGrant
        : inputGrants.has(permissionKey(row));
    if (!reused && !event?.isTrusted) {
      fail(
        row,
        errorValue("NotAllowedError", "请点击工作台上的“允许本次请求”按钮"),
      );
      return;
    }
    if (!reused) {
      if (row.op === "enumerate") enumerationGrant = true;
      else inputGrants.add(permissionKey(row));
      // Scheduled Tone voices reuse the same per-preview permission and hardware.
      for (const other of requests.values())
        if (
          other !== row &&
          other.stage === "pending" &&
          (other.op === "enumerate"
            ? enumerationGrant
            : inputGrants.has(permissionKey(other)))
        )
          queueMicrotask(() => void allow(other.id));
    }
    row.stage = "opening";
    lastError = "";
    state();
    try {
      if (row.op === "enumerate") {
        const list = await devices();
        if (!row.closed && connected())
          finish(row, { type: "devices", devices: list });
        return;
      }
      if (!capture && !captureTask) {
        const task = createCapture(row).finally(() => {
          if (captureTask === task) captureTask = undefined;
        });
        captureTask = task;
      }
      const current = capture ?? (await captureTask);
      if (row.closed || !connected()) {
        if (!authorized()) releaseCapture(current);
        return;
      }
      if (row.device !== undefined) {
        const selected = choose(await devices(), row.device);
        if (selected.deviceId !== current.device.deviceId)
          throw errorValue(
            "NotReadableError",
            "另一个麦克风正在使用中；请先停止本预览的麦克风，再选择此设备",
          );
      }
      row.stage = "active";
      row.openedDevice = current.device;
      row.lastAck = row.lastSeen = performance.now();
      if (
        !post(row, {
          type: "ready",
          device: current.device,
          sampleRate: row.sampleRate,
          channels: row.channels,
          chunkFrames: CHUNK_FRAMES,
          maxInFlight: MAX_IN_FLIGHT,
        })
      ) {
        finish(row);
        return;
      }
      clearTimeout(row.timer);
      state();
    } catch (error) {
      if (!row.closed) {
        if (error.name === "NotAllowedError") {
          denied = true;
          inputGrants.clear();
          enumerationGrant = false;
        }
        fail(row, error);
      }
    }
  };
  const receive = (event) => {
    if (
      event.source !== windowProxy ||
      iframe.current !== element ||
      event.data?.type !== TYPE
    )
      return;
    const port = event.ports[0];
    if (!port) return;
    const data = event.data;
    const invalid = (message) => {
      port.postMessage({ type: "error", code: "TypeError", message });
      port.close();
    };
    if (!connected()) {
      invalid("预览已经更换");
      return;
    }
    const allowedKeys = [
      "type",
      "op",
      "requestId",
      "sampleRate",
      "channels",
      "device",
      "version",
    ];
    if (
      Object.keys(data).some((key) => !allowedKeys.includes(key)) ||
      (data.version !== undefined && data.version !== 1)
    ) {
      invalid("无效的麦克风请求字段");
      return;
    }
    if (
      !["open", "enumerate"].includes(data.op) ||
      typeof data.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(data.requestId)
    ) {
      invalid("无效的麦克风请求");
      return;
    }
    if (requests.has(data.requestId)) {
      invalid("重复的麦克风请求身份");
      return;
    }
    if (
      data.op === "open" &&
      (!Number.isInteger(data.sampleRate) ||
        data.sampleRate < 8000 ||
        data.sampleRate > 192000 ||
        ![1, 2].includes(data.channels))
    ) {
      invalid("麦克风采样率须为8000到192000的整数，声道须为1或2");
      return;
    }
    if (
      data.device !== undefined &&
      !(
        (typeof data.device === "string" && data.device.length <= 200) ||
        (Number.isInteger(data.device) && data.device >= 0 && data.device < 64)
      )
    ) {
      invalid("无效的麦克风设备选择");
      return;
    }
    if (
      [...requests.values()].filter((row) => row.stage === "pending").length >=
        MAX_PENDING ||
      requests.size >= MAX_LEASES
    ) {
      port.postMessage({
        type: "error",
        code: "QuotaExceededError",
        message: "本预览的麦克风请求过多，请关闭已有请求",
      });
      port.close();
      return;
    }
    const row = {
      id: data.requestId,
      op: data.op,
      device: data.device,
      sampleRate: data.sampleRate,
      channels: data.channels,
      port,
      closed: false,
      stage: "pending",
      sequence: 0,
      inFlight: new Map(),
      position: 0,
      previous: null,
      output: Array.from({ length: data.channels ?? 1 }, () => []),
      outputFrames: 0,
      lastAck: performance.now(),
      lastSeen: performance.now(),
    };
    requests.set(row.id, row);
    row.port.onmessage = ({ data }) => {
      if (data?.type === "ping") {
        row.lastSeen = performance.now();
        return;
      }
      if (data?.type === "close") {
        finish(row);
        return;
      }
      if (
        data?.type === "ack" &&
        Number.isSafeInteger(data.sequence) &&
        row.inFlight.delete(data.sequence)
      )
        row.lastAck = row.lastSeen = performance.now();
    };
    row.port.onmessageerror = () => finish(row);
    row.port.start?.();
    post(row, { type: "ack" });
    row.timer = setTimeout(
      () =>
        fail(
          row,
          errorValue("AbortError", "等待麦克风授权超时，请重新发起请求"),
        ),
      90000,
    );
    if (denied) {
      fail(
        row,
        errorValue(
          "NotAllowedError",
          "本预览的麦克风已被拒绝或停止；请在工作台允许重新申请",
        ),
      );
      return;
    }
    state();
    if (
      row.op === "enumerate"
        ? enumerationGrant
        : inputGrants.has(permissionKey(row))
    )
      void allow(row.id);
  };
  window.addEventListener("message", receive);
  const changed = () => {
    if (!connected()) stop("预览页面已更换，麦克风已停止");
  };
  const observer = new MutationObserver(changed);
  observer.observe(element, { attributes: true, attributeFilter: ["src"] });
  const loaded = () => {
    if (requests.size || inputGrants.size || enumerationGrant)
      stop("预览已重新加载，麦克风请求已取消");
  };
  element.addEventListener("load", loaded);
  const watchdog = setInterval(() => {
    if (!connected()) {
      stop("预览页面已更换，麦克风已停止");
      return;
    }
    for (const row of requests.values())
      if (row.stage === "active" && performance.now() - row.lastSeen > 5000)
        fail(row, errorValue("AbortError", "预览不再接收音频，麦克风已停止"));
  }, 1000);
  state();
  return {
    allow,
    deny(id) {
      const row = requests.get(id);
      if (row) {
        denied = true;
        inputGrants.clear();
        enumerationGrant = false;
        fail(
          row,
          errorValue("NotAllowedError", "用户拒绝了本预览的麦克风请求"),
        );
        stop("用户拒绝了本预览的麦克风请求");
      }
    },
    stop,
    reallow(event) {
      if (event?.isTrusted) {
        denied = false;
        lastError = "";
        state();
      }
    },
    dispose() {
      stop("预览已关闭，麦克风已停止");
      disposed = true;
      window.removeEventListener("message", receive);
      observer.disconnect();
      element.removeEventListener("load", loaded);
      clearInterval(watchdog);
    },
  };
}
