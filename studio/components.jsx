import React, { useState, useEffect, useCallback } from "react";

import {
  Clapperboard,
  FolderGit2,
  Images,
  AudioLines,
  MessagesSquare,
  ListChecks,
  Settings,
  Plus,
  LogOut,
  Play,
  Upload,
  RefreshCw,
  ArrowUpRight,
  Download,
  Trash2,
  Check,
  ChevronRight,
  Film,
} from "lucide-react";

async function request(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      ...(options.body === undefined || options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "请求失败");
  return v;
}
const api = (name, args = {}) =>
  request("/api/action", {
    method: "POST",
    body: JSON.stringify({ name, args }),
  });
const time = (v) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
const bytes = (v) =>
  Number(v) > 1048576
    ? (Number(v) / 1048576).toFixed(1) + " MB"
    : (Number(v) / 1024).toFixed(1) + " KB";
const labels = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  cancelling: "取消中",
  interrupted: "中断",
};
const kinds = {
  new: "创建作品",
  validate: "检查作品",
  frame: "关键帧",
  storyboard: "分镜",
  render: "导出视频",
  build: "交互预览",
  agent: "AI 创作",
  "tools-update": "工具升级",
};
function Button({ children, icon: Icon, ...props }) {
  return (
    <button {...props}>
      {Icon && <Icon size={16} />} {children}
    </button>
  );
}
function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ children }) {
  return (
    <div className="empty">
      <Film size={32} />
      <p>{children}</p>
    </div>
  );
}
function readableAgentEvents(events) {
  const output = [];
  for (const line of events
    .filter((e) => e.kind === "log")
    .map((e) => e.data.text)
    .join("")
    .split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v.type === "item.completed" && v.item?.type === "agent_message")
        output.push(v.item.text);
      else if (
        v.type === "item.started" &&
        v.item?.type === "command_execution"
      )
        output.push("执行：" + v.item.command);
      else if (v.type === "assistant") {
        for (const c of v.message?.content || [])
          if (c.type === "text") output.push(c.text);
          else if (c.type === "tool_use") output.push("使用工具：" + c.name);
      } else if (v.type === "error")
        output.push(v.message || v.error?.message || "AI 返回错误");
    } catch {
      if (!line.startsWith("{")) output.push(line);
    }
  }
  return output.join("\n\n");
}
function GitPanel({ repo, run }) {
  const [s, setS] = useState(null),
    [message, setMessage] = useState("更新动画作品");
  const load = () => api("repositories_status", { repo }).then(setS);
  useEffect(() => {
    run(load);
  }, [repo]);
  return (
    <>
      <h2>仓库同步</h2>
      <p>
        {s?.remote || "本地内容仓库"} · {s?.branch}
      </p>
      {!s?.remote && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const url = new FormData(e.currentTarget).get("url");
            run(async () => {
              await api("repositories_remote", { repo, url });
              await load();
            });
          }}
        >
          <input
            name="url"
            type="url"
            placeholder="https://github.com/owner/repository"
            required
          />
          <Button>关联 GitHub 仓库</Button>
        </form>
      )}
      <div className="row">
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "fetch" });
              await load();
            })
          }
        >
          获取远程状态
        </Button>
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "pull" });
              await load();
            })
          }
        >
          拉取
        </Button>
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "push" });
              await load();
            })
          }
        >
          推送（含 LFS）
        </Button>
      </div>
      <pre>{s?.changes || "工作区无改动"}</pre>
      <div className="row">
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="提交说明"
        />
        <Button
          className="primary"
          onClick={() =>
            run(async () => {
              await api("repositories_sync", {
                repo,
                action: "commit",
                message,
              });
              await load();
            })
          }
        >
          提交改动
        </Button>
      </div>
      <details>
        <summary>源码差异</summary>
        <pre>{s?.diff || "无差异"}</pre>
      </details>
      <pre>{s?.history}</pre>
    </>
  );
}
function Editor({ repo, project, run, setNotice }) {
  const [files, setFiles] = useState([]),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [sha, setSha] = useState(null);
  useEffect(() => {
    run(async () => setFiles(await api("project_files", { repo, project })));
  }, [repo, project]);
  const open = (f) =>
    run(async () => {
      const r = await api("project_read", { repo, project, path: f });
      setFile(f);
      setContent(r.content);
      setSha(r.sha256);
    });
  return (
    <>
      <h2>作品源码</h2>
      <div className="row">
        <select value={file} onChange={(e) => open(e.target.value)}>
          <option value="">选择文件</option>
          {files
            .filter((f) => /\.(ts|tsx|js|json|md|svg|css|txt)$/.test(f.path))
            .map((f) => (
              <option key={f.path}>{f.path}</option>
            ))}
        </select>
        <Button
          disabled={!file}
          className="primary"
          onClick={() =>
            run(async () => {
              const r = await api("project_write", {
                repo,
                project,
                path: file,
                expectedSha256: sha,
                content,
              });
              setSha(r.sha256);
              setNotice("源码已保存");
            })
          }
        >
          保存
        </Button>
      </div>
      <textarea
        className="code-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck="false"
        aria-label="文件内容"
      />
    </>
  );
}
function SpeechPage({ run, repo, project, selectors, setNotice }) {
  const [engines, setEngines] = useState([]),
    [engine, setEngine] = useState(""),
    [text, setText] = useState(
      "你好，欢迎来到 FRAME。让每一个想法，都有自己的声音。",
    ),
    [result, setResult] = useState(null),
    [models, setModels] = useState([]),
    [show, setShow] = useState(false),
    [editing, setEditing] = useState(null);
  const load = async () => {
    const e = await api("engines_list");
    setEngines(e);
    setEngine((v) => v || e[0]?.id || "");
  };
  useEffect(() => {
    run(async () => {
      await load();
      setModels(await api("models_list"));
    });
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">VOICE STUDIO</span>
          <h1>为故事，找到合适的声音。</h1>
          <p>本地中文合成与外部引擎，在同一个工作室中试听。</p>
        </div>
        <Button
          icon={Plus}
          onClick={() => {
            setEditing(null);
            setShow(!show);
          }}
        >
          添加外部引擎
        </Button>
      </div>
      {show && (
        <form
          className="panel form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            run(async () => {
              await api("engines_save", {
                ...f,
                ...(editing ? { id: editing.id } : {}),
                enabled: f.enabled === "true",
              });
              setShow(false);
              await load();
            });
          }}
        >
          {[
            ["name", "名称", ""],
            ["url", "兼容 API 基础地址", "https://api.openai.com/v1"],
            ["model", "模型", ""],
            ["voice", "声线", ""],
            ["apiKey", "API Key", ""],
          ].map(([name, label, placeholder]) => (
            <Field key={name} label={label}>
              <input
                name={name}
                key={(editing?.id || "new") + name}
                defaultValue={
                  name === "name"
                    ? editing?.name
                    : name === "apiKey"
                      ? ""
                      : editing?.config?.[name] || ""
                }
                type={name === "apiKey" ? "password" : "text"}
                placeholder={placeholder}
                required={name !== "apiKey"}
              />
            </Field>
          ))}
          <Field label="状态">
            <select
              name="enabled"
              defaultValue={String(editing?.enabled ?? true)}
              key={editing?.id || "new"}
            >
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </Field>
          <Button className="primary">保存引擎</Button>
        </form>
      )}
      <div className="two-columns">
        <div className="panel">
          <h2>语音试听</h2>
          <Button
            className="text-button"
            disabled={!engine}
            onClick={() => {
              setEditing(engines.find((e) => e.id === engine));
              setShow(true);
            }}
          >
            编辑所选引擎
          </Button>
          <Field label="语音引擎">
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="合成文本">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows="7"
            />
          </Field>
          <div className="row">
            <Button
              className="primary"
              icon={Play}
              disabled={!engine}
              onClick={() =>
                run(async () =>
                  setResult(await api("speech_test", { engine, text })),
                )
              }
            >
              生成并试听
            </Button>
            <Button
              disabled={!engine || !project}
              onClick={() =>
                run(async () => {
                  setResult(
                    await api("speech_test", { engine, text, repo, project }),
                  );
                  setNotice("配音已保存到目标作品素材目录");
                })
              }
            >
              生成到作品
            </Button>
          </div>
          {selectors}
          {result && (
            <div className="speech-result">
              <audio
                controls
                autoPlay
                src={"/api/assets/" + result.asset.id + "/file"}
              />
              <p>
                耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒 · 已存入素材库
              </p>
            </div>
          )}
        </div>
        <div className="panel">
          <h2>本地模型</h2>
          <p>支持 Kokoro 权重、配置和声线文件。内置模型使用 CPU。</p>
          {models.map((m) => (
            <div className="model" key={m.id}>
              <div>
                <strong>{m.id}</strong>
                <span className="badge">
                  {m.ready ? "文件就绪" : "等待上传"}
                </span>
              </div>
              <small>{m.voices?.join(" · ") || "暂无声线"}</small>
              <div className="row">
                <Button
                  disabled={!m.ready || !m.voices?.length}
                  onClick={() =>
                    run(async () => {
                      const v = await api("engines_save", {
                        name: "Kokoro · " + m.id,
                        url: "http://speech:8000/v1",
                        model: m.id,
                        voice: m.voices[0],
                      });
                      await load();
                      setEngine(v.id);
                      setNotice("已添加本地语音引擎");
                    })
                  }
                >
                  添加为语音引擎
                </Button>
                {m.id !== "builtin" && (
                  <Button
                    onClick={() =>
                      run(async () => {
                        await api("models_delete", { id: m.id });
                        setModels(await api("models_list"));
                      })
                    }
                  >
                    删除模型
                  </Button>
                )}
              </div>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = new FormData(e.currentTarget).get("id");
              run(async () => {
                await api("models_create", { id });
                setModels(await api("models_list"));
              });
            }}
            className="row"
          >
            <input name="id" placeholder="新模型 ID，如 my-voice" required />
            <Button icon={Plus}>新建</Button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                id = f.get("id");
              f.delete("id");
              run(async () => {
                await request("/api/models/" + id + "/upload", {
                  method: "POST",
                  body: f,
                });
                setModels(await api("models_list"));
                setNotice("模型文件上传完成");
              });
            }}
          >
            <Field label="上传到模型">
              <select name="id">
                {models
                  .filter((m) => m.id !== "builtin")
                  .map((m) => (
                    <option key={m.id}>{m.id}</option>
                  ))}
              </select>
            </Field>
            <Field label="模型内路径">
              <input
                name="path"
                placeholder="config.json / model.pth / voices/zf_custom.pt"
                required
              />
            </Field>
            <input type="file" name="file" required />
            <Button icon={Upload}>上传模型文件</Button>
          </form>
        </div>
      </div>
    </>
  );
}
function SettingsPage({ run, setNotice }) {
  const [settings, setSettings] = useState(null),
    [tokens, setTokens] = useState([]),
    [newToken, setNewToken] = useState("");
  const load = async () => {
    setSettings(await api("settings_get"));
    setTokens(await api("tokens_list"));
  };
  useEffect(() => {
    run(load);
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>工作台设置</h1>
          <p>连接创作工具、管理访问凭据与工具版本。</p>
        </div>
      </div>
      <div className="settings-grid">
        {["codex", "claude", "github"].map((provider) => (
          <form
            className="panel"
            key={provider}
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api("settings_save", { provider, ...f });
                e.target?.reset?.();
                await load();
                setNotice("配置已加密保存");
              });
            }}
          >
            <div className="section-head">
              <h2>
                {provider === "github"
                  ? "GitHub"
                  : provider === "codex"
                    ? "Codex"
                    : "Claude"}
              </h2>
              <span className="badge">
                {settings?.[provider]?.configured ? "已配置" : "待配置"}
              </span>
            </div>
            <Field label={provider === "github" ? "访问令牌" : "API Key"}>
              <input
                type="password"
                name="secret"
                placeholder="留空保留已有密钥"
                autoComplete="off"
              />
            </Field>
            {provider !== "github" && (
              <>
                <Field label="API 地址（留空使用默认）">
                  <input
                    name="baseUrl"
                    defaultValue={settings?.[provider]?.baseUrl}
                    key={"url" + (settings?.[provider]?.baseUrl || "")}
                    placeholder={
                      provider === "codex"
                        ? "https://api.openai.com/v1"
                        : "https://api.anthropic.com"
                    }
                  />
                </Field>
                <Field label="模型（留空使用默认）">
                  <input
                    name="model"
                    defaultValue={settings?.[provider]?.model}
                    key={"model" + (settings?.[provider]?.model || "")}
                  />
                </Field>
              </>
            )}
            <Button className="primary">保存连接</Button>
          </form>
        ))}
      </div>
      <div className="two-columns">
        <div className="panel">
          <h2>AI 工具独立升级</h2>
          <p>
            指定版本安装。已有任务使用启动时选择的版本，新任务使用更新版本。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api("tools_update", f);
                setNotice("升级任务已提交，可在任务中心查看");
              });
            }}
          >
            <Field label="工具">
              <select name="provider">
                <option value="codex">Codex CLI</option>
                <option value="claude">Claude Code CLI</option>
              </select>
            </Field>
            <Field label="版本号">
              <input
                name="version"
                placeholder="填写明确版本号"
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+.*"
              />
            </Field>
            <Button>安装 / 切换版本</Button>
          </form>
          {settings?.tools?.map((t, i) => (
            <p key={i}>
              {t.input.provider} {t.input.version} · {labels[t.state]} {t.error}
            </p>
          ))}
        </div>
        <div className="panel">
          <h2>API / MCP 访问令牌</h2>
          <p>
            MCP 地址：<code>{location.origin}/mcp</code>
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name");
              run(async () => {
                setNewToken((await api("tokens_create", { name })).token);
                await load();
              });
            }}
          >
            <input name="name" placeholder="令牌名称" required />
            <Button icon={Plus}>创建</Button>
          </form>
          {newToken && (
            <div className="token">
              <strong>仅显示一次，请妥善保存</strong>
              <textarea readOnly value={newToken} />
            </div>
          )}
          {tokens.map((t) => (
            <div className="token-row" key={t.id}>
              <span>
                {t.name}
                <small>{time(t.created)}</small>
              </span>
              <Button
                onClick={() =>
                  run(async () => {
                    await api("tokens_revoke", { id: t.id });
                    await load();
                  })
                }
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
      </div>
      <form
        className="panel password-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget));
          run(async () => {
            await api("password_change", f);
            location.reload();
          });
        }}
      >
        <h2>修改登录密码</h2>
        <div className="row">
          <input
            name="current"
            type="password"
            placeholder="当前密码"
            required
          />
          <input
            name="password"
            type="password"
            minLength="14"
            placeholder="新密码，至少 14 位"
            required
          />
          <Button>修改并重新登录</Button>
        </div>
      </form>
    </>
  );
}

export {
  request,
  api,
  time,
  bytes,
  labels,
  kinds,
  Button,
  Field,
  Empty,
  readableAgentEvents,
  GitPanel,
  Editor,
  SpeechPage,
  SettingsPage,
};
