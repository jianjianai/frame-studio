import { useState } from "react";
import { NumberInput, useJsonDraft } from "./editor-inputs";
import {
  toneEffectLabels as effectLabels,
  toneControlFields,
  defaultToneOptions,
  toneOptionConstraint,
} from "../src/engine/tone-effect-options.mjs";
export { defaultToneOptions } from "../src/engine/tone-effect-options.mjs";
import {
  audioProcessorSchema,
  audioProcessors,
} from "../src/engine/audio-document.mjs";
import { Button } from "./ui";
const effectNames = audioProcessors.find((item) => item.id === "tone").effects;
/** Official option objects remain intact when quick controls update individual values. */
export function ToneEffectEditor({ fx, index, disabled, onChange }) {
  const json = useJsonDraft(fx.options ?? {}, `${fx.id ?? index}:${fx.effect}`);
  const [error, setError] = useState("");
  let conflicts = [];
  try {
    conflicts = json.merge().conflicts;
  } catch {
    /* Parsing is reported when Apply is requested. */
  }
  const commit = (next) => {
    try {
      const valid = audioProcessorSchema.parse(next);
      onChange(valid);
      setError("");
      return true;
    } catch (error) {
      setError(
        "参数未应用：" +
          (error.issues
            ?.map((issue) => issue.path.join(".") + ": " + issue.message)
            .join("；") || error.message),
      );
      return false;
    }
  };
  const applyJson = (prefer) => {
    try {
      const { value: options, conflicts } = json.merge(prefer);
      if (conflicts.length && !prefer)
        throw Error(
          "参数同时被 JSON 和快捷控件修改：" +
            conflicts.join("、") +
            "。请选择保留哪一方。",
        );
      if (commit({ ...fx, options })) json.reset(options);
    } catch (error) {
      setError("JSON 参数未应用：" + error.message);
    }
  };
  const fields = toneControlFields(fx.effect);
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
          const value = fx.options?.[field.key] ?? field.value;
          return (
            <label key={field.key}>
              {field.label}
              <NumberInput
                aria-label={"Tone " + field.label + " " + (index + 1)}
                disabled={disabled}
                identity={`${fx.id ?? index}:${fx.effect}:${field.key}`}
                min={field.min}
                max={field.max}
                step={field.step}
                allowExpression={
                  toneOptionConstraint(fx.effect, field.key)?.kind !==
                    "number" &&
                  [
                    "frequency",
                    "baseFrequency",
                    "dampening",
                    "delayTime",
                    "windowSize",
                    "decay",
                    "preDelay",
                    "maxDelay",
                  ].includes(field.key)
                }
                value={value}
                onCommit={(next) =>
                  commit({
                    ...fx,
                    options: { ...fx.options, [field.key]: next },
                  })
                }
              />
            </label>
          );
        })}
        <label>
          保留尾音秒
          <NumberInput
            aria-label={"Tone 保留尾音秒 " + (index + 1)}
            identity={`${fx.id ?? index}:${fx.effect}:tail`}
            min={0}
            max={120}
            step={0.1}
            disabled={disabled}
            value={fx.tail ?? 2}
            onCommit={(tail) => commit({ ...fx, tail })}
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
          value={json.text}
          onChange={(event) => {
            json.setText(event.target.value);
            setError("");
          }}
        />
        <div className="audio-key">
          <Button
            disabled={disabled || !json.dirty}
            onClick={() => applyJson()}
          >
            应用 JSON 参数
          </Button>
          <Button
            disabled={disabled}
            onClick={() => {
              json.reset();
              setError("");
            }}
          >
            恢复当前参数
          </Button>
        </div>
        {!!conflicts.length && (
          <div className="audio-key">
            <p role="status">
              冲突字段：{conflicts.join("、")}。独立字段仍会合并。
            </p>
            <Button disabled={disabled} onClick={() => applyJson("draft")}>
              冲突处保留 JSON
            </Button>
            <Button disabled={disabled} onClick={() => applyJson("current")}>
              冲突处保留快捷调整
            </Button>
          </div>
        )}
        <small className="audio-hint">
          JSON 草稿需先应用，再保存混音；快捷调整不会覆盖未应用草稿。
        </small>
      </details>
      {error && (
        <p role="alert" className="tone-json-error">
          {error}
        </p>
      )}
    </section>
  );
}
