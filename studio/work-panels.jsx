import { useEffect, useRef, useState } from "react";
import {
  Upload,
  Download,
  Trash2,
  RefreshCw,
  ExternalLink,
  Check,
  Plus,
} from "lucide-react";
import {
  api,
  useQuery,
  useAction,
  Button,
  Field,
  Form,
  Modal,
  ErrorNote,
  Empty,
  bytes,
  date,
} from "./ui";
import { RepoPicker } from "./library";
import { SpeechControls } from "./speech";

export function Materials({ repo: initialRepo, work, notify, onSelect }) {
  const [repo, setRepo] = useState(initialRepo || work?.repo || ""),
    [search, setSearch] = useState(""),
    [unused, setUnused] = useState(false),
    [deleted, setDeleted] = useState(false),
    [page, setPage] = useState(0),
    [preview, setPreview] = useState(null),
    [revision, setRevision] = useState(0),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="section-head">
        <div>
          <h2>{work ? "作品素材" : "仓库素材库"}</h2>
          <p>素材随所属仓库同步，AI 可以搜索并使用这些素材。</p>
        </div>
      </div>
      {!initialRepo && !work && (
        <RepoPicker
          value={repo}
          onChange={(value) => {
            setRepo(value);
            setPage(0);
          }}
        />
      )}
      {repo ? (
        <>
          <div className="list-toolbar">
            <input
              aria-label="搜索素材"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="搜索名称或标签"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={unused}
                onChange={(e) => {
                  setUnused(e.target.checked);
                  setPage(0);
                }}
              />
              未被作品引用
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={deleted}
                onChange={(e) => {
                  setDeleted(e.target.checked);
                  setPage(0);
                }}
              />
              回收站
            </label>
          </div>
          <MaterialList
            key={repo + ":" + revision}
            {...{
              repo,
              work,
              notify,
              onSelect,
              search,
              unused,
              deleted,
              page,
              setPage,
              setPreview,
            }}
          />
        </>
      ) : (
        <Empty>先选择素材所属的作品仓库。</Empty>
      )}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)} wide>
          <div className="material-preview">
            {preview.mime.startsWith("image/") ? (
              <img src={`/api/assets/${preview.id}/file`} alt={preview.name} />
            ) : preview.mime.startsWith("video/") ? (
              <video
                src={`/api/assets/${preview.id}/file`}
                controls
                preload="metadata"
              />
            ) : preview.mime.startsWith("audio/") ? (
              <audio
                src={`/api/assets/${preview.id}/file`}
                controls
                preload="metadata"
              />
            ) : (
              <p>此格式可下载使用。</p>
            )}
          </div>
          <Form
            busy={busy}
            onSubmit={(a) =>
              run(async () => {
                const updated = await api("assets_update", {
                  id: preview.id,
                  ...a,
                });
                setPreview({ ...preview, ...updated });
                setRevision((n) => n + 1);
                notify("素材信息已保存");
              })
            }
          >
            <Field label="素材名称">
              <input
                name="name"
                required
                maxLength="200"
                defaultValue={preview.name}
              />
            </Field>
            <Field label="标签">
              <input name="tags" maxLength="1000" defaultValue={preview.tags} />
            </Field>
            <Field label="来源与许可">
              <textarea
                name="license"
                required
                maxLength="4000"
                defaultValue={preview.license}
              />
            </Field>
          </Form>
          <p>
            {bytes(preview.bytes)} · {preview.tags}
          </p>
          <a
            className="button"
            href={`/api/assets/${preview.id}/file`}
            download
          >
            下载原件
          </a>
        </Modal>
      )}
    </>
  );
}
function MaterialList({
  repo,
  work,
  notify,
  onSelect,
  search,
  unused,
  deleted,
  page,
  setPage,
  setPreview,
}) {
  const query = useQuery("assets_list", {
      repo,
      search,
      unused,
      deleted,
      limit: 30,
      offset: page * 30,
    }),
    [run, busy] = useAction(notify),
    [progress, setProgress] = useState(null),
    [license, setLicense] = useState(""),
    [erase, setErase] = useState(null),
    upload = useRef(null),
    input = useRef(null);
  useEffect(() => () => upload.current?.abort(), []);
  const send = async (files) => {
    if (!license.trim()) {
      notify("请先填写这批素材的来源与许可说明", "error");
      return;
    }
    for (const file of files) {
      setProgress({ name: file.name, percent: 0 });
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          upload.current = xhr;
          xhr.open("POST", "/api/upload");
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
              setProgress({
                name: file.name,
                percent: Math.round((e.loaded / e.total) * 100),
              });
          };
          xhr.onerror = () => reject(new Error("上传中断，请重试"));
          xhr.onabort = () => reject(new Error("上传已取消"));
          xhr.onload = () => {
            if (xhr.status === 401)
              window.dispatchEvent(new Event("frame-auth-required"));
            let data;
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              return reject(new Error("上传响应无效"));
            }
            xhr.status >= 200 && xhr.status < 300
              ? resolve(data)
              : reject(new Error(data.error || "上传失败"));
          };
          const data = new FormData();
          data.append("repo", repo);
          data.append("license", license);
          data.append("file", file);
          xhr.send(data);
        });
        query.refresh();
      } catch (e) {
        notify(e.message, "error");
        break;
      }
    }
    setProgress(null);
    upload.current = null;
    if (input.current) input.current.value = "";
  };
  return (
    <>
      {!deleted && (
        <Field label="上传素材的来源与许可">
          <input
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            placeholder="例如：本人原创，或来源地址及许可名称"
            maxLength="4000"
          />
        </Field>
      )}
      <div
        className="upload-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!progress) void send([...e.dataTransfer.files]);
        }}
      >
        <Upload size={21} />
        <span>拖入图片、音频、视频或模型</span>
        <Button disabled={!!progress} onClick={() => input.current.click()}>
          选择文件
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => void send([...e.target.files])}
        />
      </div>
      {progress && (
        <div className="row" role="status">
          <span>
            {progress.name} · {progress.percent}%
          </span>
          <progress value={progress.percent} max="100" />
          <Button onClick={() => upload.current?.abort()}>取消上传</Button>
        </div>
      )}
      <ErrorNote error={query.error} />
      <div className="material-grid">
        {query.data?.map((a) => (
          <article className="material-card" key={a.id}>
            <button
              className="material-thumbnail"
              disabled={deleted}
              onClick={() => setPreview(a)}
            >
              {a.mime.startsWith("image/") && !deleted ? (
                <img src={`/api/assets/${a.id}/file`} alt="" loading="lazy" />
              ) : (
                <span>
                  {a.mime.startsWith("audio/")
                    ? "音频"
                    : a.mime.startsWith("video/")
                      ? "视频"
                      : "文件"}
                </span>
              )}
            </button>
            <h3 title={a.name}>{a.name}</h3>
            <p>
              {bytes(a.bytes)} ·{" "}
              {a.refs.length ? `${a.refs.length} 个作品引用` : "未引用"}
            </p>
            <div className="material-actions">
              {deleted ? (
                <>
                  <Button
                    onClick={() =>
                      run(async () => {
                        await api("assets_trash", { id: a.id, deleted: false });
                        query.refresh();
                      })
                    }
                  >
                    恢复
                  </Button>
                  <Button onClick={() => setErase(a)}>彻底删除</Button>
                </>
              ) : (
                <>
                  {work && (
                    <Button
                      icon={Plus}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api("works_use_asset", {
                            id: work.id,
                            asset: a.id,
                          });
                          onSelect?.(a);
                          query.refresh();
                          notify(
                            "素材已添加到作品，可在对话中告诉 AI 如何使用",
                          );
                        })
                      }
                    >
                      给 AI 使用
                    </Button>
                  )}
                  <Button
                    icon={Trash2}
                    aria-label={`删除素材 ${a.name}`}
                    disabled={a.refs.length > 0 || busy}
                    title={
                      a.refs.length ? "被作品引用的素材不能删除" : "移入回收站"
                    }
                    onClick={() =>
                      run(async () => {
                        await api("assets_trash", { id: a.id, deleted: true });
                        query.refresh();
                      })
                    }
                  />
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {!query.loading && !query.data?.length && (
        <Empty>没有符合条件的素材。</Empty>
      )}
      <div className="pagination">
        <Button disabled={!page} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page + 1} 页</span>
        <Button
          disabled={(query.data?.length || 0) < 30}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
      {erase && (
        <Modal title="彻底删除素材" onClose={() => setErase(null)}>
          <p>
            确认彻底删除“{erase.name}
            ”？这将删除原始文件，并在下次素材分支推送时同步删除。
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("assets_purge", { id: erase.id });
                setErase(null);
                query.refresh();
                notify("素材已彻底删除");
              })
            }
          >
            确认彻底删除
          </Button>
        </Modal>
      )}
    </>
  );
}
export function SyncPanel({ work, notify, onChange }) {
  return (
    <BranchSync
      work={work}
      repo={work.repo}
      notify={notify}
      onChange={onChange}
    />
  );
}
export function BranchSync({ work, repo, notify, onChange }) {
  const args = work ? { id: work.id } : { repo },
    operation = work ? "works_sync" : "repositories_sync",
    status = work ? "works_sync_status" : "repositories_check";
  const query = useQuery(status, args),
    [run, busy] = useAction(notify),
    state = query.data;
  const sync = (action) =>
    run(async () => {
      await api(operation, { ...args, action });
      onChange?.();
      query.refresh();
      notify(action === "push" ? "分支已推送" : "分支已拉取");
    });
  return (
    <>
      <p>
        {work
          ? "此作品的历史和同步独立于同仓库的其他作品。"
          : "仓库素材库独立保存在 frame/materials 分支，作品使用的素材同时保存在各自作品分支。"}
      </p>
      <p>
        分支：<code>{state?.branch || work?.branch || "frame/materials"}</code>
      </p>
      <ErrorNote error={query.error || state?.error} />
      <div className="sync-counts">
        <div>
          <strong>{state?.ahead ?? "—"}</strong>
          <span>本地领先</span>
        </div>
        <div>
          <strong>{state?.behind ?? "—"}</strong>
          <span>远端领先</span>
        </div>
        <div>
          <strong>{state?.dirty ?? "—"}</strong>
          <span>未提交文件</span>
        </div>
      </div>
      <p>最后检查远端：{date(state?.checked)}</p>
      {state?.remote && !state.remoteExists && (
        <p>远端还没有这个分支，首次推送会创建。</p>
      )}
      {state?.ahead > 0 && state?.behind > 0 && (
        <p className="error">分支已分叉，请先合并远端与本地的不同修改。</p>
      )}
      <div className="row">
        <Button
          icon={RefreshCw}
          disabled={busy || !state?.remote}
          onClick={() =>
            run(async () => {
              await api(status, { ...args, fetch: true });
              onChange?.();
              query.refresh();
            })
          }
        >
          刷新远端状态
        </Button>
        <Button
          disabled={
            busy || !state?.remoteExists || state?.dirty > 0 || state?.ahead > 0
          }
          onClick={() => sync("pull")}
        >
          拉取
        </Button>
        <Button
          className="primary"
          disabled={busy || !state?.remote || state?.behind > 0}
          onClick={() => sync("push")}
        >
          保存并推送
        </Button>
      </div>
      {!state?.remote && (
        <p>此仓库保存在服务器；在仓库设置中关联 GitHub 后即可同步。</p>
      )}
    </>
  );
}
export { Versions } from "./versions";
export function Details({ work, notify, onSave }) {
  const [run, busy] = useAction(notify);
  return (
    <Form
      busy={busy}
      onSubmit={(a) =>
        run(async () => {
          await api("works_update", { id: work.id, ...a });
          onSave();
          notify("资料已保存");
        })
      }
    >
      <Field label="作品名称">
        <input
          name="title"
          required
          defaultValue={work.title}
          maxLength="150"
        />
      </Field>
      <Field label="简介">
        <textarea name="description" rows="4" defaultValue={work.description} />
      </Field>
      <Field label="分类">
        <input name="category" defaultValue={work.category} />
      </Field>
      <Field label="制作状态">
        <select name="status" defaultValue={work.status}>
          <option value="draft">制作中</option>
          <option value="review">待审片</option>
          <option value="finished">已完成</option>
        </select>
      </Field>
      <p>所属仓库：{work.repository?.name}</p>
    </Form>
  );
}
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
export { Exports } from "./exports";
