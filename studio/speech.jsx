import { useState } from "react";
import { Plus, Play, Upload } from "lucide-react";
import {
  api,
  request,
  useQuery,
  useAction,
  Button,
  Field,
  Form,
  Modal,
  ErrorNote,
} from "./ui";
export function SpeechSettings({ notify }) {
  const engines = useQuery("engines_list"),
    models = useQuery("models_list"),
    [edit, setEdit] = useState(null),
    [engine, setEngine] = useState(""),
    [result, setResult] = useState(null),
    [upload, setUpload] = useState(false),
    [remove, setRemove] = useState(null),
    [removeEngine, setRemoveEngine] = useState(null),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="section-head">
        <div>
          <h2>语音引擎</h2>
          <p>内置中文模型在服务器 CPU 上运行，也可使用外部兼容服务。</p>
        </div>
        <Button icon={Plus} onClick={() => setEdit({})}>
          添加引擎
        </Button>
      </div>
      <ErrorNote error={engines.error} />
      {engines.data?.map((e) => (
        <div className="settings-row" key={e.id}>
          <div>
            <strong>{e.name}</strong>
            <p>
              {e.config.model} · {e.config.voice} ·{" "}
              {e.enabled ? "已启用" : "已停用"}
            </p>
          </div>
          <Button onClick={() => setEdit(e)}>配置</Button>
          <Button onClick={() => setRemoveEngine(e)}>删除</Button>
        </div>
      ))}
      <div className="panel">
        <h3>测试语音</h3>
        <Form
          busy={busy}
          submit="生成并试听"
          onSubmit={(a) =>
            run(async () =>
              setResult(
                await api("speech_test", {
                  engine: engine || engines.data?.[0]?.id,
                  text: a.text,
                }),
              ),
            )
          }
        >
          <Field label="测试引擎">
            <select
              value={engine || engines.data?.[0]?.id || ""}
              onChange={(e) => setEngine(e.target.value)}
              required
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
          <Field label="测试文字">
            <textarea
              name="text"
              required
              maxLength="4000"
              rows="3"
              defaultValue="你好，欢迎来到 FRAME。让每一个想法，都有自己的声音。"
            />
          </Field>
        </Form>
        {result && (
          <div>
            <audio
              controls
              autoPlay
              src={result.url || `/api/assets/${result.asset?.id}/file`}
            />
            <p>
              耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒 ·
              试听文件一天后清理
            </p>
          </div>
        )}
      </div>
      <div className="section-head">
        <h2>本地语音模型</h2>
        <Button icon={Upload} onClick={() => setUpload(true)}>
          上传模型文件
        </Button>
      </div>
      <ErrorNote error={models.error} />
      {models.data?.map((m) => (
        <div className="settings-row" key={m.id}>
          <div>
            <strong>{m.id === "builtin" ? "内置 Kokoro 中文" : m.id}</strong>
            <p>
              {m.ready ? "已就绪" : "等待模型文件"} ·{" "}
              {m.voices?.join("、") || "暂无声线"}
            </p>
          </div>
          <div className="row">
            <Button
              disabled={busy || !m.ready || !m.voices?.length}
              onClick={() =>
                run(async () => {
                  await api("engines_local", {
                    model: m.id,
                    voice: m.voices[0],
                  });
                  engines.refresh();
                  notify("本地引擎已添加");
                })
              }
            >
              添加为引擎
            </Button>
            {m.id !== "builtin" && (
              <Button onClick={() => setRemove(m.id)}>删除</Button>
            )}
          </div>
        </div>
      ))}
      {edit && (
        <Modal
          title={edit.id ? "配置语音引擎" : "添加语音引擎"}
          onClose={() => setEdit(null)}
        >
          <Form
            busy={busy}
            onSubmit={(a) =>
              run(async () => {
                await api("engines_save", {
                  ...a,
                  enabled: a.enabled === "true",
                  ...(edit.id ? { id: edit.id } : {}),
                });
                setEdit(null);
                engines.refresh();
                notify("引擎已保存");
              })
            }
          >
            {[
              ["name", "名称"],
              ["url", "API 地址"],
              ["model", "模型"],
              ["voice", "声线"],
              ["apiKey", "API 密钥"],
            ].map(([name, label]) => (
              <Field key={name} label={label}>
                <input
                  name={name}
                  type={
                    name === "apiKey"
                      ? "password"
                      : name === "url"
                        ? "url"
                        : "text"
                  }
                  defaultValue={
                    name === "name"
                      ? edit.name
                      : name === "apiKey"
                        ? ""
                        : edit.config?.[name]
                  }
                  required={name !== "apiKey"}
                  placeholder={name === "apiKey" ? "留空保留密钥" : undefined}
                />
              </Field>
            ))}
            <Field label="状态">
              <select
                name="enabled"
                defaultValue={String(edit.enabled ?? true)}
              >
                <option value="true">启用</option>
                <option value="false">停用</option>
              </select>
            </Field>
          </Form>
        </Modal>
      )}
      {removeEngine && (
        <Modal title="删除语音引擎" onClose={() => setRemoveEngine(null)}>
          <p>
            确认删除“{removeEngine.name}
            ”的引擎配置？模型文件和已生成的配音会保留。
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("engines_delete", { id: removeEngine.id });
                if (engine === removeEngine.id) setEngine("");
                setRemoveEngine(null);
                engines.refresh();
                notify("语音引擎已删除");
              })
            }
          >
            确认删除
          </Button>
        </Modal>
      )}
      {upload && (
        <Modal title="上传本地模型" onClose={() => setUpload(false)}>
          <p>支持 Kokoro 权重、配置和声线文件。</p>
          <Form
            busy={busy}
            submit="新建模型目录"
            onSubmit={(a) =>
              run(async () => {
                await api("models_create", a);
                models.refresh();
                notify("模型目录已创建");
              })
            }
          >
            <Field label="模型 ID">
              <input
                name="id"
                pattern="[a-z][a-z0-9-]+"
                required
                placeholder="my-voice"
              />
            </Field>
          </Form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                id = form.get("id");
              form.delete("id");
              run(async () => {
                await request(`/api/models/${id}/upload`, {
                  method: "POST",
                  body: form,
                });
                models.refresh();
                notify("文件上传完成");
              });
            }}
          >
            <Field label="模型目录">
              <select name="id" required>
                {models.data
                  ?.filter((m) => m.id !== "builtin")
                  .map((m) => (
                    <option key={m.id}>{m.id}</option>
                  ))}
              </select>
            </Field>
            <Field label="模型内路径">
              <input
                name="path"
                required
                placeholder="config.json / model.pth / voices/zf_custom.pt"
              />
            </Field>
            <Field label="文件">
              <input name="file" type="file" required />
            </Field>
            <Button disabled={busy}>上传文件</Button>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal title="删除本地模型" onClose={() => setRemove(null)}>
          <p>确认删除 {remove} 的模型文件？需先停用使用它的语音引擎。</p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("models_delete", { id: remove });
                setRemove(null);
                models.refresh();
              })
            }
          >
            确认删除
          </Button>
        </Modal>
      )}
    </>
  );
}
