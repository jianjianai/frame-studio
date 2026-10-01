import { useEffect, useState } from "react";
import {
  audioProcessorSchema,
  audioProcessors,
} from "../src/engine/audio-document.mjs";
import { Button } from "./ui";
const effectNames = audioProcessors.find((item) => item.id === "tone").effects;
const effectLabels = {
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
const effectFields = {
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
      (effectFields[effect] ?? []).map((field) => [field.key, field.value]),
    ),
  };
}
/** Official option objects remain intact when quick controls update individual values. */
export function ToneEffectEditor({ fx, index, disabled, onChange }) {
  const signature = JSON.stringify(fx.options ?? {});
  const [draft, setDraft] = useState(() =>
    JSON.stringify(fx.options ?? {}, null, 2),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(JSON.stringify(fx.options ?? {}, null, 2));
    setError("");
  }, [fx.effect, signature]);
  const commit = (next) => {
    try {
      const valid = audioProcessorSchema.parse(next);
      onChange(valid);
      setError("");
    } catch (error) {
      setError(
        "参数未应用：" +
          (error.issues
            ?.map((issue) => issue.path.join(".") + ": " + issue.message)
            .join("；") || error.message),
      );
    }
  };
  const applyJson = () => {
    try {
      const options = JSON.parse(draft);
      if (!options || Array.isArray(options) || typeof options !== "object")
        throw Error('参数必须是 JSON 对象，例如 {"wet":0.25}');
      if (
        typeof options.wet === "number" &&
        (options.wet < 0 || options.wet > 1)
      )
        throw Error("湿声比例必须在 0 到 1 之间");
      commit({ ...fx, options });
    } catch (error) {
      setError("JSON 参数未应用：" + error.message);
    }
  };
  const fields = [
    number("wet", "湿声比例", 1, 0, 1),
    ...(effectFields[fx.effect] ?? []),
  ];
  return (
    <section
      className="tone-effect-editor"
      role="region"
      aria-label={"Tone 效果 " + (index + 1)}
    >
      <div className="audio-form">
        <label>
          效果类型
          <select
            aria-label={"Tone 效果类型 " + (index + 1)}
            disabled={disabled}
            value={fx.effect}
            onChange={(event) =>
              commit({
                ...fx,
                effect: event.target.value,
                options: defaultToneOptions(event.target.value),
              })
            }
          >
            {effectNames.map((name) => (
              <option value={name} key={name}>
                {effectLabels[name]} · {name}
              </option>
            ))}
          </select>
        </label>
        {fields.map((field) => {
          const value = fx.options?.[field.key] ?? field.value,
            expression = typeof value === "string";
          return (
            <label key={field.key}>
              {field.label}
              <input
                aria-label={"Tone " + field.label + " " + (index + 1)}
                disabled={disabled}
                type={expression ? "text" : "number"}
                min={expression ? undefined : field.min}
                max={expression ? undefined : field.max}
                step={field.step}
                value={value}
                onChange={(event) => {
                  if (!event.target.value.trim()) return;
                  const next = expression
                    ? event.target.value
                    : Math.min(
                        field.max,
                        Math.max(field.min, Number(event.target.value)),
                      );
                  if (!expression && !Number.isFinite(next)) return;
                  commit({
                    ...fx,
                    options: { ...fx.options, [field.key]: next },
                  });
                }}
              />
            </label>
          );
        })}
        <label>
          保留尾音秒
          <input
            aria-label={"Tone 保留尾音秒 " + (index + 1)}
            type="number"
            min="0"
            max="120"
            step=".1"
            disabled={disabled}
            value={fx.tail ?? 2}
            onChange={(event) =>
              commit({
                ...fx,
                tail: Math.min(120, Math.max(0, Number(event.target.value))),
              })
            }
          />
        </label>
      </div>
      <small className="audio-hint">
        切换效果会恢复该效果的起始参数，可撤销。完整参数支持 Tone
        的时间、频率表达式和嵌套配置。
      </small>
      <details className="tone-json-settings">
        <summary>完整官方参数 JSON</summary>
        <textarea
          aria-label={"Tone 参数 JSON " + (index + 1)}
          rows={7}
          spellCheck={false}
          disabled={disabled}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
        />
        <div className="audio-key">
          <Button
            disabled={
              disabled || draft === JSON.stringify(fx.options ?? {}, null, 2)
            }
            onClick={applyJson}
          >
            应用 JSON 参数
          </Button>
          <Button
            disabled={disabled}
            onClick={() => {
              setDraft(JSON.stringify(fx.options ?? {}, null, 2));
              setError("");
            }}
          >
            恢复当前参数
          </Button>
        </div>
      </details>
      {error && (
        <p role="alert" className="tone-json-error">
          {error}
        </p>
      )}
    </section>
  );
}
