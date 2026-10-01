/** Quick-control recommendations and confirmed official constraints are separate. */
export const toneEffectLabels = {
  AutoFilter: "自动扫频滤波",
  AutoPanner: "自动声像",
  AutoWah: "自动哇音",
  BitCrusher: "位深压缩",
  Chebyshev: "谐波失真",
  Chorus: "合唱",
  Distortion: "失真",
  FeedbackDelay: "反馈延迟",
  FrequencyShifter: "移频",
  Freeverb: "空间混响",
  JCReverb: "经典混响",
  PingPongDelay: "乒乓延迟",
  PitchShift: "移调",
  Phaser: "相位器",
  Reverb: "卷积混响",
  StereoWidener: "立体声展宽",
  Tremolo: "音量颤动",
  Vibrato: "音高颤动",
};
const number = (key, label, value, min, max, step = 0.01) => ({
  key,
  label,
  value,
  min,
  max,
  step,
});
const frequency = (value = 1) =>
  number("frequency", "调制频率 Hz", value, 0.01, 1000);
const depth = number("depth", "调制深度", 1, 0, 1);
const feedback = number("feedback", "反馈", 0.125, 0, 0.95);
const delay = number("delayTime", "延迟秒", 0.25, 0, 1);
const spread = number("spread", "声道相位角", 180, 0, 360, 1);
export const toneEffectFields = {
  AutoFilter: [
    frequency(),
    depth,
    number("baseFrequency", "基础频率 Hz", 200, 20, 20000, 1),
    number("octaves", "扫频八度", 2.6, 0, 8),
  ],
  AutoPanner: [frequency(), depth],
  AutoWah: [
    number("baseFrequency", "基础频率 Hz", 100, 20, 20000, 1),
    number("octaves", "扫频八度", 6, 0, 8),
    number("sensitivity", "灵敏度 dB", 0, -96, 24, 1),
    number("Q", "滤波 Q", 2, 0.01, 50),
  ],
  BitCrusher: [number("bits", "位深", 4, 1, 16, 1)],
  Chebyshev: [number("order", "谐波阶数", 1, 1, 100, 1)],
  Chorus: [
    frequency(1.5),
    number("delayTime", "延迟毫秒", 3.5, 0.01, 20),
    { ...depth, value: 0.7 },
    number("feedback", "反馈", 0, 0, 0.95),
    spread,
  ],
  Distortion: [number("distortion", "失真强度", 0.4, 0, 1)],
  FeedbackDelay: [delay, feedback],
  FrequencyShifter: [number("frequency", "移频 Hz", 0, -20000, 20000, 1)],
  Freeverb: [
    number("roomSize", "空间大小", 0.7, 0, 1),
    number("dampening", "高频阻尼 Hz", 3000, 20, 20000, 1),
  ],
  JCReverb: [number("roomSize", "空间大小", 0.5, 0, 1)],
  PingPongDelay: [delay, { ...feedback, value: 0.5 }],
  PitchShift: [
    number("pitch", "移调半音", 0, -48, 48, 1),
    number("windowSize", "音高处理窗秒", 0.1, 0.001, 1),
    number("delayTime", "延迟秒", 0, 0, 1),
    { ...feedback, value: 0 },
  ],
  Phaser: [
    frequency(0.5),
    number("baseFrequency", "基础频率 Hz", 350, 20, 20000, 1),
    number("octaves", "扫频八度", 3, 0, 8),
    number("Q", "滤波 Q", 10, 0.01, 50),
    number("stages", "滤波级数", 10, 1, 24, 1),
  ],
  Reverb: [
    number("decay", "混响衰减秒", 1.5, 0.001, 30),
    number("preDelay", "预延迟秒", 0.01, 0, 1),
  ],
  StereoWidener: [number("width", "立体声宽度", 0.5, 0, 1)],
  Tremolo: [frequency(10), { ...depth, value: 0.5 }, spread],
  Vibrato: [
    frequency(5),
    { ...depth, value: 0.1 },
    number("maxDelay", "最大延迟秒", 0.005, 0.001, 0.1, 0.001),
  ],
};
export function defaultToneOptions(effect = "Reverb") {
  return {
    wet: 0.25,
    ...Object.fromEntries(
      (toneEffectFields[effect] ?? []).map((field) => [field.key, field.value]),
    ),
  };
}

const normal = { min: 0, max: 1, kind: "number" };
const frequencyValue = { min: 0, kind: "frequency" };
const positive = { min: 0, kind: "number" };
const official = {
  AutoFilter: {
    depth: normal,
    frequency: frequencyValue,
    baseFrequency: frequencyValue,
  },
  AutoPanner: { depth: normal, frequency: frequencyValue },
  AutoWah: { baseFrequency: frequencyValue, Q: positive },
  BitCrusher: { bits: { min: 1, max: 16, kind: "number" } },
  Chebyshev: { order: { integer: true, kind: "number" } },
  Chorus: { frequency: frequencyValue, feedback: normal },
  FeedbackDelay: { feedback: normal, delayTime: { min: 0, kind: "time" } },
  FrequencyShifter: { frequency: { kind: "frequency" } },
  Freeverb: { roomSize: normal, dampening: frequencyValue },
  JCReverb: { roomSize: normal },
  PingPongDelay: { feedback: normal, delayTime: { min: 0, kind: "time" } },
  PitchShift: {
    feedback: normal,
    delayTime: { min: 0, kind: "time" },
    windowSize: { min: 0, kind: "time" },
  },
  Phaser: {
    frequency: frequencyValue,
    baseFrequency: frequencyValue,
    Q: positive,
  },
  Reverb: {
    decay: { min: 0.001, kind: "time" },
    preDelay: { min: 0, kind: "time" },
  },
  StereoWidener: { width: normal },
  Tremolo: { depth: normal, frequency: frequencyValue },
  Vibrato: {
    depth: normal,
    frequency: frequencyValue,
    maxDelay: { min: 0, kind: "time" },
  },
};
export function toneOptionConstraint(effect, key) {
  return key === "wet" ? normal : official[effect]?.[key];
}
/** Validate finite scalar bounds confirmed by Tone 15.1.22. Musical Time/Frequency
 * strings and quantity objects stay available; their interpretation belongs to Tone.
 * UI recommendations (e.g. Reverb 30 seconds) are not official hard limits. */
export function toneOptionIssues(effect, options) {
  const issues = [];
  for (const [key, value] of Object.entries(options)) {
    const rule = toneOptionConstraint(effect, key);
    if (!rule) continue;
    // Numeric seconds/Hz strings are still scalars; do not let a negative
    // scalar bypass bounds simply by spelling it as an official unit string.
    const scalarText =
      typeof value === "string" && rule.kind !== "number"
        ? value
            .trim()
            .match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:s|hz)?$/i)
        : null;
    let scalar = scalarText ? Number(value.replace(/(?:s|hz)$/i, "")) : value;
    if (
      scalarText &&
      ((rule.kind === "time" && /hz$/i.test(value)) ||
        (rule.kind === "frequency" && /s$/i.test(value)))
    )
      scalar = 1 / scalar;
    if (typeof scalar !== "number") {
      if (
        rule.kind !== "number" &&
        ((typeof value === "string" && value.trim()) ||
          (value &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            Object.values(value).every(
              (v) => typeof v === "number" && Number.isFinite(v),
            )))
      )
        continue;
      issues.push({
        path: [key],
        message:
          rule.kind === "number"
            ? "Tone 参数必须为有限数字"
            : "Tone 参数须为数字、官方时间/频率表达式或数量对象",
      });
      continue;
    }
    if (
      !Number.isFinite(scalar) ||
      (rule.integer && !Number.isInteger(scalar)) ||
      (rule.min !== undefined && scalar < rule.min) ||
      (rule.max !== undefined && scalar > rule.max)
    ) {
      issues.push({
        path: [key],
        message: rule.integer
          ? "Tone order 必须为整数"
          : `Tone 参数范围 ${rule.min ?? "−∞"} 到 ${rule.max ?? "+∞"}`,
      });
    }
  }
  return issues;
}

export const toneControlFields = (effect) => [
  number("wet", "湿声比例", 1, 0, 1),
  ...(toneEffectFields[effect] ?? []),
];
