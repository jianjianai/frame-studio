import { useState } from "react";

import { api, useQuery, useAction, Button, Field, Form, Modal, ErrorNote, date } from "./ui";

export function Versions({ work, notify, onRestore }) {
  const [offset, setOffset] = useState(0),
    query = useQuery("works_versions", { id: work.id, limit: 50, offset }),
    [run, busy] = useAction(notify),
    [selected, setSelected] = useState(null);
  return (
    <>
      <p>
        每个作品拥有独立的 Git 历史。AI
        修改会自动保存版本，推送后历史随作品分支同步。恢复会新建记录，保留当前内容。
      </p>
      <Form
        busy={busy}
        submit="保存当前版本"
        onSubmit={(a) =>
          run(async () => {
            await api("works_checkpoint", { id: work.id, name: a.name });
            query.refresh();
          })
        }
      >
        <Field label="版本名称">
          <input name="name" required placeholder="例如：已确认的开场" />
        </Field>
      </Form>
      <ErrorNote error={query.error} />
      {query.data?.map((v) => (
        <div className="settings-row" key={v.id}>
          <div>
            <strong>{v.name}</strong>
            <p>
              {date(v.created)} ·{" "}
              {v.kind === "git" ? v.id.slice(0, 8) : "本地旧快照"}
            </p>
          </div>
          <Button onClick={() => setSelected(v)}>恢复</Button>
        </div>
      ))}
      <div className="button-row">
        <Button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          上一页
        </Button>
        <Button
          disabled={
            (query.data?.filter((v) => v.kind === "git").length || 0) < 50
          }
          onClick={() => setOffset(offset + 50)}
        >
          下一页
        </Button>
      </div>
      {selected && (
        <Modal title="恢复作品版本" onClose={() => setSelected(null)}>
          <p>恢复到“{selected.name}”？当前内容会先自动保存。</p>
          <Button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("works_restore", {
                  id: work.id,
                  version: selected.id,
                });
                await api("works_task", { id: work.id, kind: "build" });
                setSelected(null);
                query.refresh();
                onRestore?.();
                notify("作品已恢复，正在刷新预览");
              })
            }
          >
            确认恢复
          </Button>
        </Modal>
      )}
    </>
  );
}
