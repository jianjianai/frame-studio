import { useEffect, useState } from "react";
import {
  Plus,
  FolderGit2,
  Film,
  ArrowLeft,
  Search,
  Trash2,
  Settings2,
  Clock3,
  ChevronRight,
  LayoutGrid,
  List,
  RefreshCw,
  X,
  RotateCcw,
  ArrowUpRight,
  Pencil,
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
import {
  LibraryMenu,
  LibrarySkeleton,
  WorkCover,
  productionLabels,
  readLibraryView,
  saveLibraryView,
} from "./library-components";
import "./library.css";

export function RepoPicker({ value, onChange, refreshKey = 0 }) {
  const [search, setSearch] = useState("");
  const query = useQuery("repositories_page", {
    search: useDebouncedValue(search),
    limit: 30,
  });
  const selected = useQuery(value ? "repositories_get" : null, { repo: value });
  useEffect(() => {
    query.refresh();
  }, [refreshKey]);
  useEffect(() => {
    if (!value && !search && query.data?.items.length === 1)
      onChange(query.data.items[0].id);
  }, [query.data, value, search]);
  const items = query.data?.items || [];
  return (
    <div className="repo-picker">
      <Field label="搜索仓库">
        <input
          aria-label="搜索仓库"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索仓库名称"
          maxLength={200}
        />
      </Field>
      <Field label="所属仓库">
        <select
          aria-label="所属仓库"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          disabled={query.loading && !query.data}
        >
          <option value="">选择仓库</option>
          {selected.data && !items.some((r) => r.id === value) && (
            <option value={value}>{selected.data.name}</option>
          )}
          {items.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
      </Field>
      {query.loading && !query.data && (
        <small role="status">正在读取仓库…</small>
      )}
      <ErrorNote error={query.error || selected.error} />
      {query.error && (
        <Button type="button" onClick={query.refresh}>
          重试读取仓库
        </Button>
      )}
      {!query.loading && !query.error && !items.length && (
        <p className="quiet">
          {search
            ? "没有匹配的仓库，换个名称搜索。"
            : "尚未添加仓库，请先添加一个存放作品的位置。"}
        </p>
      )}
    </div>
  );
}
export function NewWork({ repo, onClose, notify, localMode = false }) {
  const [selected, setSelected] = useState(repo?.id || ""),
    [created, setCreated] = useState(null),
    [adding, setAdding] = useState(false),
    [pickerRevision, setPickerRevision] = useState(0),
    [run, busy] = useAction(notify);
  const repositories = useQuery("repositories_page", { limit: 30, offset: 0 });
  useEffect(() => { if (localMode && !selected && repositories.data?.items?.length) setSelected(repositories.data.items[0].id); }, [localMode, repositories.data, selected]);
  return (
    <Modal title="新建作品" onClose={onClose}>
      {created && (
        <p role="status">
          作品已创建。浏览器未打开新标签页，
          <a
            href={"#/work/" + created.id}
            target="_blank"
            rel="noopener"
            onClick={onClose}
          >
            点击打开作品 ↗
          </a>
        </p>
      )}
      <p>{repo ? `保存到 ${repo.name}` : localMode ? "作品保存在这台电脑。也可以选择其他作品仓库。" : "选择一个仓库保存作品"}</p>
      {!created && (
        <Form
          busy={busy}
          disabled={!selected}
          submit="创建并开始创作"
          onSubmit={(a) =>
            run(async () => {
              const tab = localMode ? null : window.open("about:blank", "_blank");
              if (tab) {
                tab.opener = null;
                tab.document.title = "正在创建作品…";
              }
              let work;
              try {
                work = await api("works_create", {
                  title: a.title,
                  repo: selected,
                });
              } catch (error) {
                tab?.close();
                throw error;
              }
              if (localMode) { onClose(); location.hash = "/work/" + work.id; return; }
              if (tab && !tab.closed)
                tab.location.replace(
                  new URL("#/work/" + work.id, location.href).href,
                );
              else setCreated(work);
              if (tab && !tab.closed) onClose();
            })
          }
        >
          {!repo && (
            <>
              <RepoPicker
                value={selected}
                onChange={setSelected}
                refreshKey={pickerRevision}
              />
              <Button type="button" icon={Plus} onClick={() => setAdding(true)}>
                添加作品仓库
              </Button>
            </>
          )}
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
        </Form>
      )}
      {adding && (
        <AddRepository
          notify={notify}
          onClose={() => setAdding(false)}
          onAdded={(repo) => {
            setSelected(repo.id);
            setPickerRevision((n) => n + 1);
            setAdding(false);
          }}
        />
      )}
    </Modal>
  );
}
export function WorkLibrary({ repo, recent = false, notify, localMode = false }) {
  const [scope, setScope] = useState(recent ? "recent" : "all");
  const [status, setStatus] = useState(""),
    [search, setSearch] = useState("");
  const [sort, setSort] = useState(recent ? "opened" : "updated"),
    [page, setPage] = useState(0);
  const [view, setView] = useState(readLibraryView);
  const [settings, setSettings] = useState(false),
    [create, setCreate] = useState(false);
  const [rename, setRename] = useState(null);
  const [remove, setRemove] = useState(null),
    [confirmation, setConfirmation] = useState("");
  const [purge, setPurge] = useState(null),
    [purgeFailures, setPurgeFailures] = useState([]);
  const [run, busy] = useAction(notify);
  const deleted = scope === "trash",
    pageSize = 24;
  const debouncedSearch = useDebouncedValue(search.trim());
  const query = useQuery("works_page", {
    ...(repo ? { repo: repo.id } : {}),
    recent: scope === "recent",
    deleted,
    status,
    sort,
    search: debouncedSearch,
    limit: pageSize,
    offset: page * pageSize,
  });
  const trash = useQuery(deleted ? "works_page" : null, {
    ...(repo ? { repo: repo.id } : {}),
    deleted: true,
    limit: 1,
  });
  const refresh = () => {
    query.refresh();
    trash.refresh();
  };
  const refreshTrash = () => {
    setPage(0);
    refresh();
  };
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (query.loading || query.error || !query.data) return;
    const last = Math.max(0, Math.ceil(query.data.total / pageSize) - 1);
    if (page > last) setPage(last);
  }, [query.data, query.loading, query.error, page]);
  const selectScope = (value) => {
    setScope(value);
    setPage(0);
    setStatus("");
    setSearch("");
    setSort(value === "recent" ? "opened" : "updated");
  };
  const clearFilters = () => {
    setStatus("");
    setSearch("");
    setPage(0);
  };
  const changeView = (value) => {
    setView(value);
    saveLibraryView(value);
  };
  const items = query.data?.items || [],
    total = query.data?.total || 0;
  const filtered = !!(search.trim() || status);
  return (
    <section className="library-page" aria-labelledby="library-title">
      <header className="library-heading">
        <div>
          {repo && (
            <a href="#/repositories" className="breadcrumb">
              <ArrowLeft size={14} />
              作品仓库
            </a>
          )}
          <div className="library-eyebrow">
            {repo ? "作品空间" : "你的创作空间"}
          </div>
          <h1 id="library-title">{repo?.name || "作品库"}</h1>
          <p>
            {repo
              ? "在这里整理作品，继续创作，或查看最新进展。"
              : "找到上次的灵感，开始下一部作品。"}
          </p>
        </div>
        <div className="library-heading-actions">
          {repo && (
            <Button icon={Settings2} onClick={() => setSettings(true)}>
              仓库设置
            </Button>
          )}
          <Button
            className="primary"
            icon={Plus}
            onClick={() => setCreate(true)}
          >
            新建作品
          </Button>
        </div>
      </header>
      <div className="library-navigation">
        <div className="library-scopes" role="group" aria-label="作品范围">
          {[
            ["all", Film, "全部作品"],
            ["recent", Clock3, "最近打开"],
            ["trash", Trash2, "回收站"],
          ].map(([id, Icon, label]) => (
            <Button
              key={id}
              icon={Icon}
              aria-pressed={scope === id}
              className={scope === id ? "selected" : ""}
              onClick={() => selectScope(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        {!repo && (
          <a href="#/repositories" className="library-repositories-link">
            <FolderGit2 size={15} />
            管理作品仓库
            <ChevronRight size={14} />
          </a>
        )}
      </div>
      {deleted && (
        <div className="library-trash-note">
          <Trash2 size={18} />
          <p>
            这里的作品已移入回收站，内容和素材仍然保留。恢复后即可继续创作。
          </p>
          <Button
            className="danger-text"
            disabled={
              busy || trash.loading || !!trash.error || !trash.data?.total
            }
            onClick={() => {
              setPurgeFailures([]);
              setPurge({ all: true, count: trash.data.total });
            }}
          >
            清空回收站（{trash.data?.total || 0}）
          </Button>
          <ErrorNote error={trash.error} />
          {trash.error && (
            <Button onClick={trash.refresh}>重试读取回收站</Button>
          )}
        </div>
      )}
      <div className="library-toolbar">
        <div className="search-box library-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索作品"
            value={search}
            maxLength={200}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="搜索作品名称或简介"
          />
          {search && (
            <Button
              icon={X}
              className="library-icon-button"
              aria-label="清除搜索"
              onClick={() => {
                setSearch("");
                setPage(0);
              }}
            />
          )}
        </div>
        <label className="library-filter">
          <span>状态</span>
          <select
            aria-label="制作状态筛选"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(productionLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="library-filter">
          <span>排序</span>
          <select
            aria-label="作品排序"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(0);
            }}
          >
            <option value="updated">最近修改</option>
            <option value="opened">最近打开</option>
            <option value="created">最新创建</option>
            <option value="title">名称 A → Z</option>
          </select>
        </label>
        <div
          className="library-view-switch"
          role="group"
          aria-label="作品显示方式"
        >
          <Button
            icon={LayoutGrid}
            aria-label="卡片视图"
            title="卡片视图"
            aria-pressed={view === "grid"}
            className={view === "grid" ? "selected" : ""}
            onClick={() => changeView("grid")}
          />
          <Button
            icon={List}
            aria-label="列表视图"
            title="列表视图"
            aria-pressed={view === "list"}
            className={view === "list" ? "selected" : ""}
            onClick={() => changeView("list")}
          />
        </div>
        <Button
          icon={RefreshCw}
          className="library-icon-button"
          aria-label="刷新作品"
          title="刷新作品"
          disabled={query.loading}
          onClick={refresh}
        />
      </div>
      <div className="library-results">
        <span role="status" aria-live="polite">
          {query.loading
            ? "正在读取作品…"
            : query.error
              ? "作品读取失败"
              : (filtered ? "找到 " : "共 ") + total + " 部作品"}
        </span>
        {filtered ? (
          <Button icon={X} onClick={clearFilters}>
            清除筛选
          </Button>
        ) : (
          <span>
            {deleted ? "恢复后回到作品库" : "打开作品会在新标签页继续创作"}
          </span>
        )}
      </div>
      {query.error && (
        <div className="library-error">
          <ErrorNote error={query.error} />
          <Button icon={RefreshCw} onClick={refresh}>
            重试加载作品
          </Button>
        </div>
      )}
      {query.loading && !query.data ? (
        <LibrarySkeleton view={view} />
      ) : items.length ? (
        <>
          {view === "list" && (
            <div className="library-list-heading" aria-hidden="true">
              <span>作品</span>
              <span>制作状态</span>
              <span>{scope === "recent" ? "上次打开" : "最近修改"}</span>
              <span>操作</span>
            </div>
          )}
          <div
            className={
              "library-works " + (view === "grid" ? "work-grid" : "work-list")
            }
            aria-busy={query.loading}
          >
            {items.map((work) => {
              const Open = deleted ? "div" : "a";
              const workLink = "#/work/" + work.id;
              return (
                <article
                  className={
                    "work-card library-work " + (deleted ? "is-deleted" : "")
                  }
                  key={work.id}
                >
                  <Open
                    className="work-open"
                    {...(!deleted
                      ? {
                          href: workLink,
                          target: "_blank",
                          rel: "noopener",
                          "aria-label": work.title + "（在新标签页打开）",
                        }
                      : {})}
                  >
                    <WorkCover work={work} />
                    <div className="work-card-info">
                      <h3 title={work.title}>{work.title}</h3>
                      <p className="library-description">
                        {work.description ||
                          (deleted ? "恢复后即可继续编辑" : "尚未添加作品简介")}
                      </p>
                      <div className="library-work-meta">
                        <span title={work.storage_name}>
                          {work.storage_name || repo?.name || "作品仓库"}
                        </span>
                        {work.composition && (
                          <span>
                            {work.composition.width} × {work.composition.height}
                          </span>
                        )}
                      </div>
                    </div>
                  </Open>
                  <div className="library-work-status work-card-status">
                    <span className={"badge production-" + work.status}>
                      {productionLabels[work.status] || "制作中"}
                    </span>
                    {work.activity && work.activity.state !== "succeeded" && (
                      <span className={"badge " + work.activity.state}>
                        {kinds[work.activity.kind] || "任务"} ·{" "}
                        {states[work.activity.state] || "状态更新中"}
                      </span>
                    )}
                    {!deleted &&
                      work.opened &&
                      work.modified &&
                      new Date(work.modified) > new Date(work.opened || 0) && (
                        <span className="library-update-dot">有新修改</span>
                      )}
                    {work.unavailable && (
                      <span className="badge failed">内容需检查</span>
                    )}
                  </div>
                  <div className="library-work-date">
                    <span>{scope === "recent" ? "打开于" : "修改于"}</span>
                    <time
                      dateTime={
                        scope === "recent"
                          ? work.opened || undefined
                          : work.modified || work.updated || undefined
                      }
                    >
                      {date(
                        scope === "recent"
                          ? work.opened
                          : work.modified || work.updated,
                      )}
                    </time>
                  </div>
                  <div className="library-work-actions">
                    {deleted ? (
                      <>
                        <Button
                          icon={RotateCcw}
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api("works_trash", {
                                id: work.id,
                                deleted: false,
                              });
                              notify("已恢复「" + work.title + "」");
                              refresh();
                            })
                          }
                        >
                          恢复作品
                        </Button>
                        <LibraryMenu
                          label={work.title + "操作"}
                          disabled={busy}
                          items={[
                            {
                              label: "永久删除",
                              icon: Trash2,
                              danger: true,
                              action: () => {
                                setPurgeFailures([]);
                                setPurge(work);
                              },
                            },
                          ]}
                        />
                      </>
                    ) : (
                      <>
                        <a
                          className="button library-continue"
                          href={workLink}
                          target="_blank"
                          rel="noopener"
                        >
                          继续创作
                          <ArrowUpRight size={15} />
                        </a>
                        <LibraryMenu
                          label={work.title + "操作"}
                          disabled={busy}
                          items={[
                            {
                              label: "重命名",
                              icon: Pencil,
                              action: () => setRename(work),
                            },
                            {
                              label: "删除",
                              icon: Trash2,
                              danger: true,
                              action: () => {
                                setConfirmation("");
                                setRemove(work);
                              },
                            },
                          ]}
                        />
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        !query.error && (
          <Empty
            action={
              filtered ? (
                <Button onClick={clearFilters}>清除筛选</Button>
              ) : deleted ? (
                <Button icon={Film} onClick={() => selectScope("all")}>
                  返回全部作品
                </Button>
              ) : (
                <div className="row">
                  <Button
                    className="primary"
                    icon={Plus}
                    onClick={() => setCreate(true)}
                  >
                    创建作品
                  </Button>
                  {scope === "recent" && (
                    <Button onClick={() => selectScope("all")}>
                      浏览全部作品
                    </Button>
                  )}
                </div>
              )
            }
          >
            <span className="library-empty-icon">
              {deleted ? <Trash2 size={28} /> : <Film size={28} />}
            </span>
            <strong>
              {filtered
                ? "没有符合当前筛选条件的作品"
                : deleted
                  ? "回收站为空"
                  : scope === "recent"
                    ? "还没有最近打开的作品"
                    : "从一个想法开始"}
            </strong>
            <p>
              {filtered
                ? "试试其他关键词，或清除筛选条件。"
                : deleted
                  ? "移入回收站的作品会出现在这里。"
                  : scope === "recent"
                    ? "浏览全部作品，或新建作品开始创作。"
                    : "新建一部作品，把画面、声音和制作交给 AI。"}
            </p>
          </Empty>
        )
      )}
      <Pagination page={page} setPage={setPage} total={total} size={pageSize} />
      {settings && (
        <Modal title="仓库设置" onClose={() => setSettings(false)}>
          <RepositorySettings
            repo={repo}
            notify={notify}
            onSaved={() => {
              refresh();
              setSettings(false);
            }}
          />
        </Modal>
      )}
      {create && (
        <NewWork
          repo={repo}
          notify={notify}
          localMode={localMode}
          onClose={() => {
            setCreate(false);
            refresh();
          }}
        />
      )}
      {rename && (
        <Modal title="重命名作品" onClose={() => setRename(null)}>
          <Form
            busy={busy}
            submit="保存名称"
            onSubmit={(values) =>
              run(async () => {
                await api("works_update", {
                  id: rename.id,
                  expectedRevision: rename.metadataRevision,
                  title: values.title.trim(),
                });
                setRename(null);
                notify("作品名称已保存");
                refresh();
              })
            }
          >
            <Field label="作品名称">
              <input
                name="title"
                required
                autoFocus
                defaultValue={rename.title}
                maxLength={150}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {remove && (
        <Modal title="移入回收站" onClose={() => setRemove(null)}>
          <p>
            「<strong>{remove.title}</strong>
            」将从作品列表移除。内容和素材会保留，可在回收站恢复。
          </p>
          <Form
            busy={busy}
            protect={false}
            submit="移入回收站"
            disabled={confirmation !== remove.title}
            onSubmit={(values) =>
              run(async () => {
                await api("works_trash", {
                  id: remove.id,
                  deleted: true,
                  confirm: values.confirm,
                });
                setRemove(null);
                notify("作品已移入回收站");
                refresh();
              })
            }
          >
            <Field label="输入作品名称确认">
              <input
                name="confirm"
                required
                autoFocus
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={remove.title}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {purge && (
        <Modal
          title={purge.all ? "清空回收站" : "永久删除作品"}
          onClose={() => {
            if (!busy) setPurge(null);
          }}
        >
          <p>
            {purge.all
              ? `将永久删除${repo ? `仓库“${repo.name}”` : "全部仓库"}回收站中的 ${trash.data?.total || 0} 个作品，包含所有分页和筛选之外的作品。`
              : `将永久删除作品“${purge.title}”。`}
            作品文件、历史版本、聊天和导出记录将被清除，对应远端作品分支也会删除。
            素材库中的共享素材保留。此操作无法恢复。
          </p>
          {!!purgeFailures.length && (
            <div role="alert">
              <p>以下作品未能删除，仍在回收站中。处理原因后可重试。</p>
              <ul>
                {purgeFailures.map((failure) => (
                  <li key={failure.id}>
                    <strong>{failure.title}</strong>：{failure.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Form
            busy={busy}
            submit={purgeFailures.length ? "重试清空" : "确认永久删除"}
            onSubmit={(a) =>
              run(async () => {
                if (purge.all) {
                  const result = await api("works_empty_trash", {
                    ...(repo ? { repo: repo.id } : {}),
                    confirm: a.confirm,
                  });
                  setPurgeFailures(result.failed);
                  notify(
                    `已永久删除 ${result.purged.length} 个作品${result.failed.length ? `，${result.failed.length} 个未能删除` : ""}`,
                    result.failed.length ? "error" : "success",
                  );
                  if (!result.failed.length) setPurge(null);
                } else {
                  await api("works_purge", {
                    id: purge.id,
                    confirm: a.confirm,
                  });
                  notify("作品和对应远端分支已永久删除");
                  setPurge(null);
                }
                refreshTrash();
              })
            }
          >
            <Field
              label={
                purge.all
                  ? "输入“清空回收站”确认"
                  : `输入完整作品名称“${purge.title}”确认`
              }
            >
              <input
                name="confirm"
                required
                autoFocus
                autoComplete="off"
                disabled={busy}
              />
            </Field>
          </Form>
        </Modal>
      )}
    </section>
  );
}
export function Repositories({ notify, onOpen }) {
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [account, setAccount] = useState("");
  const [add, setAdd] = useState(false),
    [create, setCreate] = useState(false);
  const query = useQuery("repositories_page", {
    search: useDebouncedValue(search.trim()),
    limit: 30,
    offset: page * 30,
    ...(account ? { account } : {}),
  });
  const accounts = useQuery("github_accounts");
  useEffect(() => {
    if (!query.loading && !query.error && query.data) {
      const last = Math.max(0, Math.ceil(query.data.total / 30) - 1);
      if (page > last) setPage(last);
    }
  }, [query.data, query.loading, query.error, page]);
  const clearFilters = () => {
    setSearch("");
    setAccount("");
    setPage(0);
  };
  return (
    <section className="library-page" aria-labelledby="repositories-title">
      <header className="library-heading">
        <div>
          <div className="library-eyebrow">组织你的创作</div>
          <h1 id="repositories-title">作品仓库</h1>
          <p>按主题或项目整理作品，每个仓库共享自己的素材。</p>
        </div>
        <div className="library-heading-actions">
          <Button icon={Plus} onClick={() => setAdd(true)}>
            添加仓库
          </Button>
          <Button
            className="primary"
            icon={Plus}
            onClick={() => setCreate(true)}
          >
            新建作品
          </Button>
        </div>
      </header>
      <div className="library-navigation">
        <a className="library-repositories-link" href="#/library">
          <ArrowLeft size={15} />
          返回作品库
        </a>
        <span className="library-navigation-note">
          打开仓库，查看其中的作品与素材
        </span>
      </div>
      <div className="library-toolbar">
        <div className="search-box library-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索仓库"
            value={search}
            maxLength={200}
            placeholder="搜索仓库名称或地址"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
          {search && (
            <Button
              icon={X}
              className="library-icon-button"
              aria-label="清除仓库搜索"
              onClick={() => {
                setSearch("");
                setPage(0);
              }}
            />
          )}
        </div>
        <label className="library-filter">
          <span>账号</span>
          <select
            aria-label="GitHub 账号筛选"
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
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
        </label>
        <Button
          icon={RefreshCw}
          className="library-icon-button"
          title="刷新仓库"
          aria-label="刷新仓库"
          disabled={query.loading}
          onClick={query.refresh}
        />
      </div>
      <div className="library-results">
        <span role="status" aria-live="polite">
          {query.loading
            ? "正在读取仓库…"
            : query.error
              ? "仓库读取失败"
              : "共 " + (query.data?.total || 0) + " 个仓库"}
        </span>
        {(search || account) && (
          <Button icon={X} onClick={clearFilters}>
            清除筛选
          </Button>
        )}
      </div>
      {accounts.error && (
        <div className="library-error">
          <ErrorNote error={accounts.error} />
          <Button onClick={accounts.refresh}>重试读取账号</Button>
        </div>
      )}
      {query.error && (
        <div className="library-error">
          <ErrorNote error={query.error} />
          <Button icon={RefreshCw} onClick={query.refresh}>
            重试加载仓库
          </Button>
        </div>
      )}
      {query.loading && !query.data ? (
        <LibrarySkeleton />
      ) : query.data?.items.length ? (
        <div className="repository-grid">
          {query.data.items.map((repository) => (
            <button
              className="repository-card"
              key={repository.id}
              onClick={() => onOpen(repository)}
            >
              <div className="library-repository-top">
                <span className="library-repository-icon">
                  <FolderGit2 size={25} strokeWidth={1.5} />
                </span>
                <span className="library-storage-type">
                  {repository.url ? "GitHub 同步" : "本地存储"}
                </span>
              </div>
              <h3>{repository.name}</h3>
              <p className="library-repository-account">
                {repository.login ||
                  (repository.url ? "已关联远端仓库" : "保存在当前服务器")}
              </p>
              <div className="library-repository-footer">
                <span>
                  <Film size={15} />
                  {repository.work_count} 部作品
                </span>
                <span>
                  查看作品
                  <ChevronRight size={16} />
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty
            action={
              search || account ? (
                <Button onClick={clearFilters}>清除筛选</Button>
              ) : (
                <Button
                  className="primary"
                  icon={Plus}
                  onClick={() => setAdd(true)}
                >
                  添加第一个仓库
                </Button>
              )
            }
          >
            <span className="library-empty-icon">
              <FolderGit2 size={28} />
            </span>
            <strong>
              {search || account ? "没有匹配的仓库" : "给作品一个家"}
            </strong>
            <p>
              {search || account
                ? "换一个关键词或账号，重新查找。"
                : "连接已有 GitHub 仓库，或创建一个本地仓库开始创作。"}
            </p>
          </Empty>
        )
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
          onAdded={(repository) => {
            query.refresh();
            setAdd(false);
            onOpen(repository);
          }}
        />
      )}
      {create && (
        <NewWork
          notify={notify}
          onClose={() => {
            setCreate(false);
            query.refresh();
          }}
        />
      )}
    </section>
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
