import { useState } from "react";

import { api, useQuery, useAction, Field, Form } from "./ui";

import { SpeechControls } from "./speech";

export function Voice({ work, notify }) {
  const engines = useQuery("engines_list"),
    [run, busy] = useAction(notify),
    [result, setResult] = useState(null),
    [selected, setSelected] = useState(""),
    [voice, setVoice] = useState(""),
    [speed, setSpeed] = useState(1);
  const engine =
    engines.data?.find((e) => e.id === selected) ||
    engines.data?.find((e) => e.enabled);
  return (
    <>
      <Form
        busy={busy}
        submit="生成并添加到作品"
        onSubmit={(a) =>
          run(async () => {
            setResult(
              await api("works_speech", {
                id: work.id,
                text: a.text,
                engine: engine.id,
                voice: voice || engine.config.voice,
                speed,
              }),
            );
            notify("配音已添加，可让 AI 把它放入时间轴");
          })
        }
      >
        <Field label="语音引擎">
          <select
            name="engine"
            required
            value={engine?.id || ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setVoice("");
            }}
          >
            {engines.data
              ?.filter((e) => e.enabled)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </Field>
        <SpeechControls
          engine={engine}
          voice={voice || engine?.config.voice || ""}
          setVoice={setVoice}
          speed={speed}
          setSpeed={setSpeed}
        />
        <Field label="配音文字">
          <textarea name="text" rows="6" required maxLength="4000" />
        </Field>
      </Form>
      {result && <audio controls src={`/api/assets/${result.asset.id}/file`} />}
      <a href="#/settings">管理语音引擎</a>
    </>
  );
}
