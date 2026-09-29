import { useState } from "react";
import { Download, Trash2, ExternalLink } from "lucide-react";
import { api, useQuery, useAction, Button, Field, Form, Modal, ErrorNote, bytes, date, states } from "./ui";

export function Exports({ work, notify, onBrowserExport }) {
  const query = useQuery("works_exports", { id: work.id }, 5000),
    [run, busy] = useAction(notify),
    [release, setRelease] = useState(null);
  return (
    <>
      <p>
        浏览器导出在当前设备计算；后台导出关闭浏览器后仍会继续。文件保留 7
        天，到期自动清理。
      </p>
      <div className="row">
        <Button icon={Download} onClick={onBrowserExport}>
          在浏览器导出 WebM
        </Button>
        <Button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api("works_task", {
                id: work.id,
                kind: "render",
                input: {}, // The export runtime derives width from this work’s composition.
              });
              query.refresh();
              notify("后台导出已开始");
            })
          }
        >
          后台导出 MP4
        </Button>
      </div>
      <ErrorNote error={query.error} />
      {query.data?.map((t) => (
        <div className="export-item" key={t.id}>
          <div className="section-head">
            <strong>{date(t.created)}</strong>
            <span>
              {t.cleaned
                ? "已清理"
                : t.state === "succeeded"
                  ? "导出完成"
                  : t.state === "failed"
                    ? "导出失败"
                    : states[t.state] || "状态待确认"}
            </span>
          </div>
          {t.error && <p className="error">{t.error}</p>}
          {!t.cleaned &&
            t.result?.artifacts
              ?.filter((a) => /\.(mp4|webm)$/.test(a.path))
              .map((a) => (
                <div className="settings-row" key={a.path}>
                  <div>
                    <strong>{a.name}</strong>
                    <p>
                      {bytes(a.bytes)} · {date(t.expires)} 后清理
                    </p>
                  </div>
                  <div className="row">
                    <a
                      className="button"
                      href={`/api/tasks/${t.id}/file/${a.path}`}
                      download
                    >
                      下载
                    </a>
                    <Button
                      icon={ExternalLink}
                      onClick={() =>
                        setRelease({ task: t.id, artifact: a.path })
                      }
                    >
                      发布到 Releases
                    </Button>
                  </div>
                </div>
              ))}
          {t.result?.releases?.map((r) => (
            <a key={r.url} href={r.url} target="_blank" rel="noreferrer">
              查看 Release · {r.tag}
            </a>
          ))}
          {!t.cleaned &&
            ["succeeded", "failed", "cancelled"].includes(t.state) && (
              <Button
                icon={Trash2}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api("exports_delete", { id: t.id });
                    query.refresh();
                    notify(
                      r.removed ? "临时文件已清理" : "文件正在使用，请稍后再试",
                    );
                  })
                }
              >
                清理临时文件
              </Button>
            )}
        </div>
      ))}
      {release && (
        <Modal title="发布到 GitHub Releases" onClose={() => setRelease(null)}>
          <p>视频会上传到当前作品所属仓库。</p>
          <Form
            busy={busy}
            submit="发布视频"
            onSubmit={(a) =>
              run(async () => {
                const r = await api("exports_release", { ...release, ...a });
                setRelease(null);
                query.refresh();
                notify("发布完成：" + r.url);
              })
            }
          >
            <Field label="发布标签">
              <input
                name="tag"
                required
                defaultValue={"film-" + new Date().toISOString().slice(0, 10)}
              />
            </Field>
            <Field label="标题">
              <input name="title" defaultValue={work.title} required />
            </Field>
            <Field label="说明">
              <textarea name="notes" rows="3" />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
