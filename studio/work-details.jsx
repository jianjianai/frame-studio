import { api, useAction, Form, Field } from "./ui";
export function Details({ work, notify, onSave }) {
  const [run, busy] = useAction(notify);
  return (
    <Form
      busy={busy}
      onSubmit={(a) =>
        run(async () => {
          await api("works_update", {
            id: work.id,
            expectedRevision: work.metadataRevision,
            ...a,
          });
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
        <textarea
          name="description"
          rows="4"
          defaultValue={work.description}
          maxLength={4000}
        />
      </Field>
      <Field label="分类">
        <input name="category" defaultValue={work.category} maxLength={80} />
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
