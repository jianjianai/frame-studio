import { useEffect, useState } from "react";
import { Play, Check } from "lucide-react";
import {
  api,
  useQuery,
  useAction,
  Button,
  Field,
  Form,
  ErrorNote,
  Loading,
} from "./ui";
import { SpeechControls, useSpeechJob, SpeechProgress } from "./speech";
import { reviewTime } from "./review-text";
const load = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
};
export function Voice({ work, notify, position = {}, onAdopt }) {
  const key = "frame.voice-draft:" + work.id,
    initial = load(key);
  const engines = useQuery("engines_list"),
    models = useQuery("models_list"),
    [run, busy] = useAction(notify);
  const [selected, setSelected] = useState(initial.engine || ""),
    [voice, setVoice] = useState(initial.voice || ""),
    [speed, setSpeed] = useState(initial.speed || 1),
    [options, setOptions] = useState(initial.options || {}),
    [text, setText] = useState(initial.text || "");
  const [name, setName] = useState(initial.name || "中文旁白"),
    [result, setResult] = useState(null),
    [adopted, setAdopted] = useState(null),
    [placement, setPlacement] = useState("none");
  const job = useSpeechJob(),
    [error, setError] = useState("");
  const engine =
    engines.data?.find((e) => e.id === selected && e.enabled) ||
    engines.data?.find((e) => e.enabled);
  const chosenVoice = voice || engine?.config?.voice || "";
  const installed =
    engine?.kind === "external" ||
    models.data?.some((m) => m.id === engine?.config?.model && m.ready);
  const settings = {
    engine: engine?.id,
    voice: chosenVoice,
    speed,
    text,
    options,
  };
  const signature = JSON.stringify(settings),
    stale = result && result.signature !== signature;
  useEffect(() => {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ engine: selected, voice, speed, text, name, options }),
      );
    } catch {}
  }, [key, selected, voice, speed, text, name, options]);
  return (
    <>
      <p>
        先生成试听，确认后保存这份音频，不会重复合成。保存为资源不等于已进入时间轴，可再把编排要求交给
        AI。
      </p>
      <ErrorNote error={engines.error} />
      {engines.error && (
        <Button onClick={engines.refresh}>重试读取语音引擎</Button>
      )}
      {engines.loading && !engines.data ? (
        <Loading />
      ) : !engine ? (
        <p>
          还没有可用的语音引擎。
          <a href="#/settings" target="_blank" rel="noopener">
            配置语音引擎 ↗
          </a>
        </p>
      ) : (
        <>
          <Form
            busy={busy}
            disabled={!text.trim() || !chosenVoice || !installed}
            submit="生成试听（不加入作品）"
            onSubmit={() =>
              run(async () => {
                setError("");
                let sample;
                try {
                  sample = await api("speech_test", {
                    ...settings,
                    requestId: job.start(),
                  });
                } finally {
                  job.finish();
                }
                setResult({ ...sample, signature });
                setAdopted(null);
                notify("试听已生成，确认后可采用");
              })
            }
          >
            {!installed && (
              <p>
                此模型尚未安装，请在
                <a href="#/settings" target="_blank" rel="noopener">
                  语音引擎列表
                </a>
                下载或上传模型后重新打开配音。
              </p>
            )}
            <Field label="语音引擎">
              <select
                name="engine"
                aria-label="语音引擎"
                value={engine.id}
                disabled={busy}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setVoice("");
                  setOptions({});
                  setSpeed(1);
                }}
              >
                {engines.data
                  .filter((e) => e.enabled)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </Field>
            <SpeechControls
              engine={engine}
              voice={chosenVoice}
              setVoice={setVoice}
              speed={speed}
              setSpeed={setSpeed}
              options={options}
              setOptions={setOptions}
              disabled={busy}
            />
            <Field label="配音文字">
              <textarea
                name="text"
                rows={6}
                required
                maxLength={4000}
                value={text}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <small>
              文字与设置会在当前浏览器会话中保留。首次调用引擎可能需要加载模型。
            </small>
          </Form>
          {job.requestId && <SpeechProgress job={job} error={setError} />}
          <ErrorNote error={error} />
          {result && (
            <section className="voice-audition">
              <h3>
                <Play size={17} /> 试听结果
              </h3>
              {result.warnings?.map((w) => (
                <p key={w.field} role="alert">
                  {w.field}：{w.reason}
                </p>
              ))}
              <audio controls src={result.url} preload="metadata" />
              <p>
                临时试听保留至{" "}
                {new Date(result.expiresAt).toLocaleString("zh-CN")}
                。采用后保存到本作品，不受试听到期影响。
              </p>
              {stale && (
                <ErrorNote error="文字或声线设置已改变。请重新生成试听，避免采用旧音频。" />
              )}
              {!adopted ? (
                <Form
                  busy={busy}
                  disabled={stale}
                  submit="采用这份试听，保存为作品资源"
                  onSubmit={() =>
                    run(async () => {
                      const saved = await api("works_speech_adopt", {
                        id: work.id,
                        task: result.task,
                        name,
                      });
                      setAdopted(saved.asset);
                      notify("这份试听已保存为作品资源，尚未编排到时间轴");
                    })
                  }
                >
                  <Field label="配音资源名称">
                    <input
                      name="name"
                      required
                      maxLength={180}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                </Form>
              ) : (
                <div className="voice-adopted">
                  <strong>
                    <Check size={17} /> 已保存：{adopted.name}
                  </strong>
                  <Field label="希望 AI 如何使用">
                    <select
                      aria-label="配音编排位置"
                      value={placement}
                      onChange={(event) => setPlacement(event.target.value)}
                    >
                      <option value="none">作为参考，让 AI 决定编排</option>
                      <option value="time" disabled={!position.duration}>
                        从当前时间 {reviewTime(position.time)} 开始
                      </option>
                      <option
                        value="range"
                        disabled={
                          !(position.selection?.end > position.selection?.start)
                        }
                      >
                        适配当前选段
                      </option>
                    </select>
                  </Field>
                  <Button
                    onClick={() =>
                      onAdopt?.(
                        adopted,
                        placement === "time"
                          ? { time: Number(position.time || 0) }
                          : placement === "range"
                            ? {
                                time: position.selection.start,
                                start: position.selection.start,
                                end: position.selection.end,
                              }
                            : null,
                      )
                    }
                  >
                    带入 AI 对话，填写编排要求
                  </Button>
                  <p>只填入引用与草稿，不会自动发送创作任务。</p>
                </div>
              )}
            </section>
          )}
        </>
      )}
      <a href="#/settings" target="_blank" rel="noopener">
        管理语音引擎 ↗
      </a>
    </>
  );
}
