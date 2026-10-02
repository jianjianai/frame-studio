import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  mergeJsonDraft,
  parseNumberDraft,
  stableJson,
} from "./editor-drafts.mjs";

const NumericDraftContext = createContext(null);

/** Fields keep their own text. The editor only re-renders when the aggregate
 * pending state changes, and this stable callback also clears removed fields. */
export function NumericDraftProvider({ children, onDirtyChange, resetKey }) {
  const pending = useRef(new Set());
  const reported = useRef(false);
  const report = useCallback(
    (token, dirty) => {
      if (dirty) pending.current.add(token);
      else pending.current.delete(token);
      const next = pending.current.size > 0;
      if (next !== reported.current) {
        reported.current = next;
        onDirtyChange(next);
      }
    },
    [onDirtyChange],
  );
  const scope = useMemo(() => ({ report, resetKey }), [report, resetKey]);
  return (
    <NumericDraftContext.Provider value={scope}>
      {children}
    </NumericDraftContext.Provider>
  );
}

/** Save and drag both use the latest committed numeric value. Invalid drafts
 * stay visible and focused; advanced JSON still requires its own Apply action. */
export function flushNumericPending(root) {
  if (!root) return false;
  const active = root.ownerDocument.activeElement;
  if (active?.matches('input[role="spinbutton"]') && root.contains(active))
    flushSync(() => active.blur());
  const invalid = root.querySelector(
    'input[role="spinbutton"][aria-invalid="true"]',
  );
  if (!invalid) return true;
  for (
    let parent = invalid.parentElement;
    parent && parent !== root;
    parent = parent.parentElement
  )
    if (parent.tagName === "DETAILS") parent.open = true;
  invalid.focus();
  return false;
}

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
  const scope = useContext(NumericDraftContext);
  const token = useRef({});
  const report = scope?.report;
  const notify = (dirty) => report?.(token.current, dirty);
  useEffect(() => () => report?.(token.current, false), [report]);
  const [draft, setDraft] = useState(() => displayValue(value));
  const [error, setError] = useState("");
  const skipBlur = useRef(false),
    editing = useRef(false),
    baseline = useRef(displayValue(value));
  useEffect(() => {
    if (!editing.current || draft === baseline.current) {
      baseline.current = displayValue(value);
      setDraft(baseline.current);
      notify(false);
    } else notify(draft !== displayValue(value));
  }, [value]);
  useEffect(() => {
    baseline.current = displayValue(value);
    setDraft(baseline.current);
    setError("");
    editing.current = false;
    skipBlur.current = false;
    notify(false);
  }, [identity, scope?.resetKey]);
  const restore = () => {
    baseline.current = displayValue(value);
    setDraft(baseline.current);
    setError("");
    notify(false);
  };
  const commit = () => {
    const parsed = parseNumberDraft(draft, { min, max, allowExpression });
    if (parsed.error) {
      setError(parsed.error);
      notify(true);
      return false;
    }
    if (parsed.value !== value && onCommit(parsed.value) === false) {
      setError("参数未应用，请检查处理器提示或按 Escape 恢复");
      notify(true);
      return false;
    }
    setError("");
    setDraft(displayValue(parsed.value));
    baseline.current = displayValue(parsed.value);
    notify(false);
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
          notify(event.target.value !== displayValue(value));
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
            if (next !== value && onCommit(next) === false) {
              setError("参数未应用，请检查处理器提示或按 Escape 恢复");
              notify(true);
            } else notify(false);
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
