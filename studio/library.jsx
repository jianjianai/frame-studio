import { useEffect, useState } from "react";
import {
  Plus,
  FolderGit2,
  MoreHorizontal,
  Film,
  ArrowLeft,
  Search,
  Trash2,
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
  Loading,
  Pagination,
  date,
  go,
  useDebouncedValue,
  states,
  kinds,
} from "./ui";
import { RepositorySettings } from "./repository-settings";
import { LoginFlow } from "./accounts";

export function RepoPicker({ value, onChange, refreshKey = 0 }) {
  const [search, setSearch] = useState("");
  const query = useQuery("repositories_page", { search: useDebouncedValue(search), limit: 30 });
  const selected = useQuery(value ? "repositories_get" : null, { repo: value });
  useEffect(() => { query.refresh(); }, [refreshKey]);
  useEffect(() => { if (!value && !search && query.data?.items.length === 1) onChange(query.data.items[0].id); }, [query.data, value, search]);
  const items = query.data?.items || [];
  return <div className="repo-picker">
    <Field label="搜索仓库"><input aria-label="搜索仓库" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索仓库名称" maxLength={200}/></Field>
    <Field label="所属仓库"><select aria-label="所属仓库" value={value} onChange={event => onChange(event.target.value)} required disabled={query.loading && !query.data}><option value="">选择仓库</option>
      {selected.data && !items.some(r => r.id === value) && <option value={value}>{selected.data.name}</option>}
      {items.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
    </select></Field>
    {query.loading && !query.data && <small role="status">正在读取仓库…</small>}
    <ErrorNote error={query.error || selected.error}/>{query.error && <Button type="button" onClick={query.refresh}>重试读取仓库</Button>}
    {!query.loading && !query.error && !items.length && <p className="quiet">{search ? "没有匹配的仓库，换个名称搜索。" : "尚未添加仓库，请先添加一个存放作品的位置。"}</p>}
  </div>;
}
export function NewWork({ repo, onClose, notify }) {
  const [selected, setSelected] = useState(repo?.id || ""),
    [created, setCreated] = useState(null),
    [adding, setAdding] = useState(false),
    [pickerRevision, setPickerRevision] = useState(0),
    [run, busy] = useAction(notify);
  return (
    <Modal title="新建作品" onClose={onClose}>
      {created && <p role="status">作品已创建。浏览器未打开新标签页，<a href={"#/work/" + created.id} target="_blank" rel="noopener" onClick={onClose}>点击打开作品 ↗</a></p>}
      <p>{repo ? `保存到 ${repo.name}` : "选择一个仓库保存作品"}</p>
      {!created && <Form
        busy={busy}
        disabled={!selected}
        submit="创建并开始创作"
        onSubmit={(a) =>
          run(async () => {
            const tab = window.open("about:blank", "_blank");
            if (tab) { tab.opener = null; tab.document.title = "正在创建作品…"; }
            let work;
            try { work = await api("works_create", {
              title: a.title,
              repo: selected,
            }); } catch (error) { tab?.close(); throw error; }
            if (tab && !tab.closed) tab.location.replace(new URL("#/work/" + work.id, location.href).href);
            else setCreated(work);
            if (tab && !tab.closed) onClose();
          })
        }
      >
        {!repo && <><RepoPicker value={selected} onChange={setSelected} refreshKey={pickerRevision}/><Button type="button" icon={Plus} onClick={() => setAdding(true)}>添加作品仓库</Button></>}
        <Field label="作品名称">
          <input
            name="title"
            autoFocus
            required
            maxLength="150"
            placeholder="给你的想法起个名字"
          />
        </Field>
        <p>进入作品后告诉 AI 你的想法，画面、声音和制作方式交给 AI。</p>
      </Form>}
      {adding && <AddRepository notify={notify} onClose={() => setAdding(false)} onAdded={repo => { setSelected(repo.id); setPickerRevision(n => n + 1); setAdding(false); }}/>}
    </Modal>
  );
}
export function WorkLibrary({ repo, recent = false, notify }) {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [deleted, setDeleted] = useState(false),
    [settings, setSettings] = useState(false),
    [create, setCreate] = useState(false),
    [edit, setEdit] = useState(null),
    [remove, setRemove] = useState(null),
    [run, busy] = useAction(notify);
  const query = useQuery("works_page", {
    ...(repo ? { repo: repo.id } : {}),
    recent,
    deleted,
    status,
    search: useDebouncedValue(search),
    limit: 30,
    offset: page * 30,
  });
  useEffect(() => { const refresh = () => query.refresh(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, []);
  return (
    <>
      <div className="page-heading row">
        <div>
          {repo && (
            <a href="#/repositories" className="breadcrumb">
              <ArrowLeft size={14} /> 仓库
            </a>
          )}
          <h1>{recent ? "最近打开" : repo?.name || "作品"}</h1>
          <p>
            {recent ? "从上次的想法继续" : "让 AI 创作，随时审片和调整方向"}
          </p>
        </div>
        <Button className="primary" icon={Plus} onClick={() => setCreate(true)}>
          新建作品
        </Button>
      </div>
      <div className="list-toolbar">
        {repo && (
          <Button onClick={() => setSettings(true)}>仓库设置与素材同步</Button>
        )}
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索作品"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="搜索作品"
          />
        </div>
        <select aria-label="制作状态筛选" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">全部制作状态</option><option value="draft">制作中</option><option value="review">待审片</option><option value="finished">已完成</option></select>
        {repo && (
          <Button
            icon={Trash2}
            className={deleted ? "selected" : ""}
            onClick={() => {
              setDeleted(!deleted);
              setPage(0);
            }}
          >
            {deleted ? "返回作品" : "回收站"}
          </Button>
        )}
      </div>
      <ErrorNote error={query.error} />
      {query.error ? <Empty action={<Button onClick={query.refresh}>重试加载作品</Button>}>暂时无法读取作品，已有作品不会因此丢失。</Empty> : query.loading && !query.data ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="work-grid">
          {query.data.items.map((w) => (
            <article className="work-card" key={w.id}>
              <a
                className="work-open"
                href={deleted ? undefined : "#/work/" + w.id}
                aria-disabled={deleted || undefined}
                target="_blank" rel="noopener"
                aria-label={w.title + "（在新标签页打开）"}
              >
                <div className="work-cover">
                  {w.cover ? (
                    <img src={w.cover} alt="" loading="lazy" />
                  ) : (
                    <Film size={40} />
                  )}
                </div>
                <div className="work-card-info">
                  <h3 title={w.title}>{w.title}</h3>
                  <div className="work-card-status"><span className={"badge production-" + w.status}>{{draft:"制作中", review:"待审片", finished:"已完成"}[w.status] || "制作中"}</span>
                    {w.activity && w.activity.state !== "succeeded" && <span className={"badge " + w.activity.state}>{kinds[w.activity.kind] || "任务"} · {states[w.activity.state] || "状态更新中"}</span>}
                    {w.modified && new Date(w.modified) > new Date(w.opened || 0) && <span className="badge ready">有新修改</span>}
                    {w.unavailable && <span className="badge failed">内容需检查</span>}
                  </div>
                  <p>
                    {recent ? w.storage_name : date(w.modified || w.updated)}
                  </p>
                  {recent && <small>打开于 {date(w.opened)}</small>}
                </div>
              </a>
              <details className="card-menu">
                <summary aria-label={`${w.title}操作`}>
                  <MoreHorizontal size={19} />
                </summary>
                <div>
                  {deleted ? (
                    <Button
                      onClick={() =>
                        run(async () => {
                          await api("works_trash", {
                            id: w.id,
                            deleted: false,
                          });
                          query.refresh();
                        })
                      }
                    >
                      恢复作品
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={(e) => {
                          e.currentTarget.closest("details").open = false;
                          setEdit(w);
                        }}
                      >
                        重命名
                      </Button>
                      <Button
                        className="danger-text"
                        onClick={(e) => {
                          e.currentTarget.closest("details").open = false;
                          setRemove(w);
                        }}
                      >
                        删除
                      </Button>
                    </>
                  )}
                </div>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <Empty action={search || status ? <Button onClick={() => { setSearch(""); setStatus(""); setPage(0); }}>清除筛选</Button> : !deleted ? <Button onClick={() => setCreate(true)}>创建作品</Button> : null}>
          {search || status ? "没有符合当前筛选条件的作品。" : deleted ? "回收站为空。" : recent ? "还没有最近打开的作品。可以打开作品仓库，或开始一个新想法。" : "这个仓库还没有作品。"}
        </Empty>
      )}
      <Pagination
        page={page}
        setPage={setPage}
        total={query.data?.total || 0}
      />
      {settings && (
        <Modal title="仓库设置" onClose={() => setSettings(false)}>
          <RepositorySettings
            repo={repo}
            notify={notify}
            onSaved={() => {
              query.refresh();
              setSettings(false);
            }}
          />
        </Modal>
      )}
      {create && (
        <NewWork repo={repo} notify={notify} onClose={() => setCreate(false)} />
      )}{" "}
      {edit && (
        <Modal title="重命名作品" onClose={() => setEdit(null)}>
          <Form
            busy={busy}
            onSubmit={(a) =>
              run(async () => {
                await api("works_update", { id: edit.id, title: a.title });
                setEdit(null);
                query.refresh();
              })
            }
          >
            <Field label="作品名称">
              <input
                name="title"
                required
                autoFocus
                defaultValue={edit.title}
                maxLength="150"
              />
            </Field>
          </Form>
        </Modal>
      )}
      {remove && (
        <Modal title="删除作品" onClose={() => setRemove(null)}>
          <p>
            输入完整名称 <strong>{remove.title}</strong>{" "}
            确认。作品和素材会保留在回收站中。
          </p>
          <Form
            busy={busy}
            submit="确认删除"
            onSubmit={(a) =>
              run(async () => {
                await api("works_trash", {
                  id: remove.id,
                  deleted: true,
                  confirm: a.confirm,
                });
                setRemove(null);
                query.refresh();
              })
            }
          >
            <Field label="输入作品名称确认">
              <input name="confirm" required autoComplete="off" />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
export function Repositories({ notify, onOpen }) {
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [account, setAccount] = useState(""),
    [add, setAdd] = useState(false);
  const query = useQuery("repositories_page", {
      search: useDebouncedValue(search),
      limit: 30,
      offset: page * 30,
      ...(account ? { account } : {}),
    }),
    accounts = useQuery("github_accounts");
  return (
    <>
      <div className="page-heading row">
        <div>
          <h1>作品仓库</h1>
          <p>按仓库组织作品、素材和发布</p>
        </div>
        <Button className="primary" icon={Plus} onClick={() => setAdd(true)}>
          添加仓库
        </Button>
      </div>
      <div className="list-toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索仓库"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="搜索仓库"
          />
        </div>
        <select
          aria-label="GitHub 账号筛选"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部账号</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.login}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={query.error} />
      {query.loading && !query.data ? (
        <Loading />
      ) : (
        <div className="repository-grid">
          {query.data?.items.map((r) => (
            <button
              className="repository-card"
              key={r.id}
              onClick={() => onOpen(r)}
            >
              <FolderGit2 size={28} />
              <h3>{r.name}</h3>
              <p>
                {r.work_count} 个作品 · {r.login || "本地仓库"}
              </p>
              <small>{r.url ? "每个作品独立分支" : "保存在服务器"}</small>
            </button>
          ))}
        </div>
      )}
      {query.error && <Button onClick={query.refresh}>重试加载仓库</Button>}
      {!query.loading && !query.error && !query.data?.items.length && (
        <Empty action={search || account ? <Button onClick={() => { setSearch(""); setAccount(""); setPage(0); }}>清除筛选</Button> : <Button onClick={() => setAdd(true)}>添加仓库</Button>}>{search || account ? "没有匹配的仓库。" : "添加已有仓库，或创建新的 GitHub 作品仓库。"}</Empty>
      )}
      <Pagination
        page={page}
        setPage={setPage}
        total={query.data?.total || 0}
      />
      {add && (
        <AddRepository
          notify={notify}
          onClose={() => setAdd(false)}
          onAdded={(r) => {
            query.refresh();
            setAdd(false);
            onOpen(r);
          }}
        />
      )}
    </>
  );
}
function AddRepository({ notify, onClose, onAdded }) {
  const [mode, setMode] = useState("existing"),
    [account, setAccount] = useState(""),
    [login, setLogin] = useState(false),
    [page, setPage] = useState(1),
    [run, busy] = useAction(notify),
    accounts = useQuery("github_accounts");
  return (
    <Modal title="添加作品仓库" onClose={onClose} wide>
      <div className="tabs">
        {[
          ["existing", "添加现有仓库"],
          ["create", "创建 GitHub 仓库"],
          ["local", "本地仓库"],
        ].map(([id, label]) => (
          <Button
            key={id}
            className={mode === id ? "selected" : ""}
            onClick={() => setMode(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      {mode !== "local" && (
        <div className="row">
          <select
            aria-label="选择 GitHub 账号"
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setPage(1);
            }}
          >
            <option value="">选择 GitHub 账号</option>
            {accounts.data?.map((a) => (
              <option value={a.id} key={a.id}>
                {a.login}
              </option>
            ))}
          </select>
          <Button icon={Plus} onClick={() => setLogin(true)}>
            登录账号
          </Button>
        </div>
      )}
      {mode === "existing" && account ? (
        <ExistingRepositories
          account={account}
          page={page}
          setPage={setPage}
          notify={notify}
          onAdded={onAdded}
        />
      ) : mode === "existing" ? (
        <Empty>选择账号后列出可用仓库。</Empty>
      ) : (
        <Form
          busy={busy}
          disabled={!account && mode !== "local"}
          submit="创建仓库"
          onSubmit={(a) =>
            run(async () =>
              onAdded(
                await api(
                  mode === "local"
                    ? "repositories_add"
                    : "github_create_repository",
                  mode === "local"
                    ? { name: a.name }
                    : {
                        account,
                        name: a.name,
                        description: a.description,
                        private: a.visibility !== "public",
                      },
                ),
              ),
            )
          }
        >
          <Field label="仓库名称">
            <input
              name="name"
              required
              maxLength="100"
              pattern={mode === "local" ? undefined : "[A-Za-z0-9_.-]+"}
            />
          </Field>
          {mode === "create" && (
            <>
              <Field label="描述">
                <input name="description" />
              </Field>
              <Field label="可见性">
                <select name="visibility">
                  <option value="private">私有</option>
                  <option value="public">公开</option>
                </select>
              </Field>
            </>
          )}
        </Form>
      )}
      {login && (
        <LoginFlow
          kind="github"
          notify={notify}
          onSuccess={accounts.refresh}
          onClose={() => {
            setLogin(false);
            accounts.refresh();
          }}
        />
      )}
    </Modal>
  );
}
function ExistingRepositories({ account, page, setPage, onAdded, notify }) {
  const query = useQuery("github_repositories", { account, page }),
    [run, busy] = useAction(notify);
  return (
    <>
      <ErrorNote error={query.error} />
      {query.loading ? (
        <Loading />
      ) : (
        query.data?.map((r) => (
          <div className="settings-row" key={r.url}>
            <div>
              <strong>{r.name}</strong>
              <p>{r.description || (r.private ? "私有仓库" : "公开仓库")}</p>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () =>
                  onAdded(
                    await api("repositories_add", {
                      name: r.name,
                      url: r.url,
                      branch: r.branch || "main",
                      account,
                    }),
                  ),
                )
              }
            >
              添加
            </Button>
          </div>
        ))
      )}
      <div className="pagination">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button
          disabled={query.data?.length < 30}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
    </>
  );
}
