import { useEffect, useRef, useState } from "react";
import {
  mergeJsonDraft,
  parseNumberDraft,
  stableJson,
} from "./editor-drafts.mjs";

const displayValue = (value) =>
  value && typeof value === "object"
    ? JSON.stringify(value)
    : String(value ?? 0);

/** Numeric editing preserves intermediate '-', '.', and exponent text. Only
 * blur/Enter commits; arrows perform one bounded step and Escape restores. */
export function NumberInput({
  value,
  identity,
  onCommit,
  min,
  max,
  step = 0.01,
  allowExpression = false,
  disabled,
  ...props
}) {
  const [draft, setDraft] = useState(() => displayValue(value));
  const [error, setError] = useState("");
  const skipBlur = useRef(false),
    editing = useRef(false),
    baseline = useRef(displayValue(value));
  useEffect(() => {
    if (!editing.current || draft === baseline.current) {
      baseline.current = displayValue(value);
      setDraft(baseline.current);
    }
  }, [value]);
  useEffect(() => {
    baseline.current = displayValue(value);
    setDraft(baseline.current);
    setError("");
    editing.current = false;
  }, [identity]);
  const restore = () => {
    baseline.current = displayValue(value);
    setDraft(baseline.current);
    setError("");
  };
  const commit = () => {
    const parsed = parseNumberDraft(draft, { min, max, allowExpression });
    if (parsed.error) {
      setError(parsed.error);
      return false;
    }
    if (parsed.value !== value && onCommit(parsed.value) === false) {
      setError("参数未应用，请检查处理器提示或按 Escape 恢复");
      return false;
    }
    setError("");
    setDraft(displayValue(parsed.value));
    baseline.current = displayValue(parsed.value);
    return true;
  };
  const numeric = typeof value === "number" && Number.isFinite(value);
  return (
    <>
      <input
        {...props}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={numeric ? value : undefined}
        aria-valuetext={numeric ? undefined : String(value)}
        aria-invalid={!!error}
        disabled={disabled}
        value={draft}
        onFocus={() => {
          editing.current = true;
          baseline.current = displayValue(value);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onBlur={() => {
          editing.current = false;
          if (skipBlur.current) {
            skipBlur.current = false;
            return;
          }
          if (!disabled) commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            restore();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (commit()) {
              skipBlur.current = true;
              event.currentTarget.blur();
            }
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const parsed = parseNumberDraft(draft, { allowExpression });
            const previous =
              typeof parsed.value === "number"
                ? parsed.value
                : numeric
                  ? value
                  : 0;
            const next = Math.min(
              max ?? Infinity,
              Math.max(
                min ?? -Infinity,
                Number(
                  (
                    previous +
                    (event.key === "ArrowUp" ? 1 : -1) * Number(step)
                  ).toPrecision(12),
                ),
              ),
            );
            setDraft(String(next));
            baseline.current = String(next);
            setError("");
            if (next !== value) onCommit(next);
          }
        }}
      />
      {error && (
        <small role="alert" className="tone-json-error">
          {error}
        </small>
      )}
    </>
  );
}

/** One draft state keeps text and its merge base together. External quick controls
 * refresh a clean draft; a dirty draft stays intact until explicit merge/apply. */
export function useJsonDraft(value, identity) {
  const signature = stableJson(value);
  const [state, setState] = useState(() => ({
    identity,
    base: value,
    text: JSON.stringify(value, null, 2),
  }));
  const clean = state.text === JSON.stringify(state.base, null, 2);
  useEffect(() => {
    setState((previous) =>
      previous.identity !== identity ||
      previous.text === JSON.stringify(previous.base, null, 2)
        ? { identity, base: value, text: JSON.stringify(value, null, 2) }
        : previous,
    );
  }, [identity, signature]);
  return {
    text: state.text,
    dirty: !clean,
    setText: (text) => setState((previous) => ({ ...previous, text })),
    reset: (next) =>
      setState({
        identity,
        base: next ?? value,
        text: JSON.stringify(next ?? value, null, 2),
      }),
    merge(prefer) {
      const draft = JSON.parse(state.text);
      if (!draft || Array.isArray(draft) || typeof draft !== "object")
        throw Error("参数必须是 JSON 对象");
      return mergeJsonDraft(state.base, draft, value, prefer);
    },
  };
}
