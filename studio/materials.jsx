import { useEffect, useRef, useState } from "react";
import { Upload, Plus, Trash2, Check } from "lucide-react";
import {
  api,
  useQuery,
  useAction,
  useDebouncedValue,
  Button,
  Field,
  Form,
  Modal,
  ErrorNote,
  Empty,
  Loading,
  bytes,
} from "./ui";
import { RepoPicker } from "./library";

function UploadMaterials({ repo, notify, onUploaded }) {
  const [license, setLicense] = useState(""),
    [progress, setProgress] = useState(null),
    [error, setError] = useState("");
  const input = useRef(null),
    xhr = useRef(null),
    running = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event) => {
      if (running.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      xhr.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);
  const send = async (files) => {
    if (running.current || !files.length) return;
    if (!license.trim()) {
      setError("请先填写这批素材的来源与许可说明，再选择文件。");
      return;
    }
    running.current = true;
    setError("");
    let uploaded = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (!mounted.current) break;
        setProgress({
          name: file.name,
          index: index + 1,
          total: files.length,
          percent: 0,
        });
        await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          xhr.current = request;
          request.open("POST", "/api/upload");
          request.timeout = 30 * 60 * 1000;
          request.upload.onprogress = (event) => {
            if (mounted.current && event.lengthComputable)
              setProgress({
                name: file.name,
                index: index + 1,
                total: files.length,
                percent: Math.round((event.loaded / event.total) * 100),
              });
          };
          request.onerror = () =>
            reject(new Error("上传连接中断，请重试未成功的文件"));
          request.ontimeout = () =>
            reject(new Error("上传超时，请重试未成功的文件"));
          request.onabort = () =>
            reject(new Error("上传已取消；已完成的文件仍然保留"));
          request.onload = () => {
            if (request.status === 401)
              window.dispatchEvent(new Event("frame-auth-required"));
            let result;
            try {
              result = JSON.parse(request.responseText);
            } catch {
              return reject(new Error("上传响应无法读取"));
            }
            request.status >= 200 && request.status < 300
              ? resolve(result)
              : reject(new Error(result.error || "上传失败"));
          };
          const body = new FormData();
          body.append("repo", repo);
          body.append("license", license);
          body.append("file", file);
          request.send(body);
        });
        uploaded++;
        onUploaded();
      }
      if (mounted.current && uploaded)
        notify(`${uploaded} 个素材已上传到仓库；尚未自动加入影片`);
    } catch (error) {
      if (mounted.current) setError(error.message);
    } finally {
      running.current = false;
      xhr.current = null;
      if (mounted.current) {
        setProgress(null);
        if (input.current) input.current.value = "";
      }
    }
  };
  return (
    <form
      className="material-upload"
      data-pending={!!progress}
      onSubmit={(event) => event.preventDefault()}
    >
      <Field label="这批素材的来源与许可">
        <input
          aria-label="上传素材来源与许可"
          value={license}
          disabled={!!progress}
          onChange={(event) => setLicense(event.target.value)}
          maxLength={4000}
          placeholder="例如：本人原创；或来源地址与许可名称"
        />
      </Field>
      <div
        className="upload-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void send([...event.dataTransfer.files]);
        }}
      >
        <Upload size={21} />
        <span>拖入图片、音频、视频或模型</span>
        <Button
          type="button"
          disabled={!!progress}
          onClick={() => input.current.click()}
        >
          选择文件
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => void send([...event.target.files])}
        />
      </div>
      <ErrorNote error={error} />
      {progress && (
        <div className="upload-progress" role="status">
          <span>
            {progress.index}/{progress.total} · {progress.name} ·{" "}
            {progress.percent}%
            {progress.percent === 100 ? " · 正在登记文件" : ""}
          </span>
          <progress value={progress.percent} max={100} />
          <Button type="button" onClick={() => xhr.current?.abort()}>
            取消剩余上传
          </Button>
        </div>
      )}
    </form>
  );
}

export function Materials({
  repo: initialRepo,
  work,
  notify,
  onSelect,
  selectedAssets = [],
  onDone,
  visible = true,
}) {
  const [repo, setRepo] = useState(
      initialRepo?.id || initialRepo || work?.repo || "",
    ),
    [scope, setScope] = useState(work ? "work" : "library");
  const [search, setSearch] = useState(""),
    [unused, setUnused] = useState(false),
    [page, setPage] = useState(0),
    [preview, setPreview] = useState(null),
    [erase, setErase] = useState(null),
    [uploadOpen, setUploadOpen] = useState(false);
  const [run, busy] = useAction(notify),
    searchValue = useDebouncedValue(search),
    deleted = scope === "trash";
  const query = useQuery(
    repo ? (scope === "work" && work ? "works_assets" : "assets_list") : null,
    scope === "work" && work
      ? { id: work.id, search: searchValue, limit: 30, offset: page * 30 }
      : {
          repo,
          search: searchValue,
          unused: !deleted && unused,
          deleted,
          limit: 30,
          offset: page * 30,
        },
  );
  useEffect(() => {
    if (visible) query.refresh();
  }, [visible]);
  const selectScope = (next) => {
    setScope(next);
    setPage(0);
    setUnused(false);
  };
  return (
    <>
      <div className="section-head">
        <div>
          <h2>{work ? "素材与参考" : "仓库素材库"}</h2>
          <p>
            {scope === "work"
              ? "已存在于本作品的资源；是否用于画面或时间轴以实际作品编排为准。"
              : "仓库资源可先提供给 AI 作为参考，也可复制到本作品；不会自动出现在时间轴。"}
          </p>
        </div>
        {!deleted && repo && (
          <Button icon={Upload} onClick={() => setUploadOpen(true)}>
            上传素材
          </Button>
        )}
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
          <div className="tabs" aria-label="素材范围">
            {work && (
              <Button
                aria-pressed={scope === "work"}
                className={scope === "work" ? "selected" : ""}
                onClick={() => selectScope("work")}
              >
                本作品资源
              </Button>
            )}
            <Button
              aria-pressed={scope === "library"}
              className={scope === "library" ? "selected" : ""}
              onClick={() => selectScope("library")}
            >
              仓库素材库
            </Button>
            <Button
              aria-pressed={deleted}
              className={deleted ? "selected" : ""}
              onClick={() => selectScope("trash")}
            >
              回收站
            </Button>
          </div>
          <div className="list-toolbar">
            <input
              aria-label="搜索素材"
              value={search}
              maxLength={200}
              placeholder="搜索素材名称或标签"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            {scope === "library" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={unused}
                  onChange={(event) => {
                    setUnused(event.target.checked);
                    setPage(0);
                  }}
                />
                未加入任何作品
              </label>
            )}
            {work && onDone && (
              <Button onClick={onDone}>
                返回对话
                {selectedAssets.length
                  ? ` · ${selectedAssets.length} 个引用`
                  : ""}
              </Button>
            )}
          </div>
          <ErrorNote error={query.error} />
          {query.error ? (
            <Empty
              action={<Button onClick={query.refresh}>重试加载素材</Button>}
            >
              素材列表读取失败，已有文件未被删除。
            </Empty>
          ) : query.loading && !query.data ? (
            <Loading />
          ) : query.data?.length ? (
            <div className="material-grid">
              {query.data.map((asset) => {
                const refs = asset.refs || [],
                  attached =
                    work &&
                    refs.some(
                      (ref) =>
                        ref.work === work.id ||
                        (ref.repo === work.repo &&
                          ref.project === work.project),
                    ),
                  selected = selectedAssets.some(
                    (item) => item.id === asset.id,
                  );
                return (
                  <article className="material-card" key={asset.id}>
                    <button
                      className="material-thumbnail"
                      disabled={deleted}
                      aria-label={"预览素材 " + asset.name}
                      onClick={() => setPreview(asset)}
                    >
                      {asset.mime.startsWith("image/") && !deleted ? (
                        <img
                          src={`/api/assets/${asset.id}/file`}
                          alt={asset.name}
                          loading="lazy"
                        />
                      ) : (
                        <span>
                          {asset.mime.startsWith("audio/")
                            ? "音频"
                            : asset.mime.startsWith("video/")
                              ? "视频"
                              : "文件"}
                        </span>
                      )}
                    </button>
                    <h3 title={asset.name}>{asset.name}</h3>
                    <p>
                      {bytes(asset.bytes)} ·{" "}
                      {attached
                        ? "已加入本作品"
                        : refs.length
                          ? `${refs.length} 个作品使用`
                          : "仅在仓库中"}
                    </p>
                    <div className="material-actions">
                      {deleted ? (
                        <>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await api("assets_trash", {
                                  id: asset.id,
                                  deleted: false,
                                });
                                query.refresh();
                              })
                            }
                          >
                            恢复
                          </Button>
                          <Button
                            className="danger-text"
                            disabled={busy}
                            onClick={() => setErase(asset)}
                          >
                            彻底删除
                          </Button>
                        </>
                      ) : (
                        <>
                          {work && onSelect && (
                            <Button
                              icon={selected ? Check : Plus}
                              disabled={
                                selected ||
                                (!selected && selectedAssets.length >= 20)
                              }
                              onClick={() => {
                                onSelect(asset);
                                notify(
                                  "已加入对话引用；发送创作要求后 AI 才会使用",
                                );
                              }}
                            >
                              {selected ? "已引用" : "引用到对话"}
                            </Button>
                          )}
                          {work && !attached && (
                            <Button
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await api("works_use_asset", {
                                    id: work.id,
                                    asset: asset.id,
                                  });
                                  query.refresh();
                                  notify(
                                    "已复制到本作品资源，尚未编排到时间轴",
                                  );
                                })
                              }
                            >
                              加入本作品资源
                            </Button>
                          )}
                          <Button
                            icon={Trash2}
                            aria-label={"删除素材 " + asset.name}
                            disabled={refs.length > 0 || busy}
                            title={
                              refs.length
                                ? "已加入作品的资源不能在素材库删除"
                                : "移入回收站"
                            }
                            onClick={() =>
                              run(async () => {
                                await api("assets_trash", {
                                  id: asset.id,
                                  deleted: true,
                                });
                                query.refresh();
                                notify("素材已移入回收站，可恢复");
                              })
                            }
                          />
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              action={
                search || unused ? (
                  <Button
                    onClick={() => {
                      setSearch("");
                      setUnused(false);
                      setPage(0);
                    }}
                  >
                    清除筛选
                  </Button>
                ) : scope === "work" ? (
                  <Button onClick={() => selectScope("library")}>
                    从仓库选择素材
                  </Button>
                ) : !deleted ? (
                  <Button onClick={() => setUploadOpen(true)}>上传素材</Button>
                ) : null
              }
            >
              {search || unused
                ? "没有符合筛选条件的素材。"
                : deleted
                  ? "回收站为空。"
                  : scope === "work"
                    ? "本作品还没有导入资源。"
                    : "仓库里还没有素材。"}
            </Empty>
          )}
          <div className="pagination">
            <span>第 {page + 1} 页</span>
            <Button
              disabled={!page || query.loading}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <Button
              disabled={query.loading || (query.data?.length || 0) < 30}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </>
      ) : (
        <Empty>先选择素材所属仓库。</Empty>
      )}
      {uploadOpen && (
        <Modal title="上传到仓库素材库" onClose={() => setUploadOpen(false)}>
          <UploadMaterials
            repo={repo}
            notify={notify}
            onUploaded={() => {
              query.refresh();
            }}
          />
          <p>
            上传完成后在“仓库素材库”中选择。引用或复制都不会自动触发 AI 创作。
          </p>
        </Modal>
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
              <p>此文件可下载后使用。</p>
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
                query.refresh();
                notify("素材信息已保存");
              })
            }
          >
            <Field label="素材名称">
              <input
                name="name"
                required
                maxLength={200}
                defaultValue={preview.name}
              />
            </Field>
            <Field label="标签">
              <input name="tags" maxLength={1000} defaultValue={preview.tags} />
            </Field>
            <Field label="来源与许可">
              <textarea
                name="license"
                required
                maxLength={4000}
                defaultValue={preview.license}
              />
            </Field>
          </Form>
          {(preview.refs || []).length > 0 && (
            <details>
              <summary>已加入的作品</summary>
              <div className="asset-works">
                {preview.refs.map((ref, i) => (
                  <a
                    key={i}
                    href={ref.work ? "#/work/" + ref.work : undefined}
                    target="_blank"
                    rel="noopener"
                  >
                    {ref.title}
                    {ref.deleted ? "（回收站）" : ""}
                  </a>
                ))}
              </div>
            </details>
          )}
          <a
            className="button"
            href={`/api/assets/${preview.id}/file`}
            download
          >
            下载原件
          </a>
        </Modal>
      )}
      {erase && (
        <Modal title="彻底删除素材" onClose={() => setErase(null)}>
          <p>
            删除“{erase.name}
            ”的原始文件？此操作不可恢复，并会在下次素材同步时删除对应远端文件。
          </p>
          <Form
            protect={false}
            busy={busy}
            submit="确认彻底删除"
            onSubmit={() =>
              run(async () => {
                await api("assets_purge", { id: erase.id });
                setErase(null);
                query.refresh();
                notify("素材已彻底删除");
              })
            }
          />
        </Modal>
      )}
    </>
  );
}
