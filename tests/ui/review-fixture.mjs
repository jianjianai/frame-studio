import { randomUUID } from "node:crypto";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";

/** Only API state is simulated. The UI/player served by the harness is production code. */
export async function mockApi(context, playerUrl, uiUrl) {
  const now = new Date().toISOString(),
    calls = [],
    errors = [],
    subscriptions = new Set();
  const repo = {
    id: randomUUID(),
    name: "验收作品仓库",
    url: "https://github.com/example/fixture",
    work_count: 1,
  };
  const work = {
    id: randomUUID(),
    repo: repo.id,
    project: "test-film",
    title: "前端交互验收",
    description: "已保存的作品简介",
    status: "review",
    category: "科普",
    repository: repo,
    storage_name: repo.name,
    opened: now,
    updated: now,
    branch: "works/test-film",
  };
  const connection = {
    id: randomUUID(),
    name: "验收模型（模拟连接）",
    configured: true,
    tool: "codex",
  };
  const chat = {
    id: randomUUID(),
    connection: connection.id,
    title: "精确审片",
  };
  const build = {
    id: randomUUID(),
    kind: "build",
    state: "succeeded",
    input: {},
    result: { previewVersion: PREVIEW_VERSION },
    created: now,
  };
  const turn = {
    id: randomUUID(),
    kind: "agent",
    state: "succeeded",
    chat: chat.id,
    input: {
      prompt: "调整这段动画",
      context: { time: 0.5, start: 0.5, end: 1.5 },
    },
    created: now,
  };
  const queued = {
    id: randomUUID(),
    kind: "agent",
    state: "queued",
    chat: chat.id,
    input: { prompt: "下一步继续制作" },
    created: now,
  };
  const assets = [
    {
      id: randomUUID(),
      name: "节奏参考.wav",
      mime: "audio/wav",
      bytes: 32000,
      license: "测试原创",
      tags: "节奏",
      refs: [],
    },
    {
      id: randomUUID(),
      name: "已加入的旁白.wav",
      mime: "audio/wav",
      bytes: 16000,
      license: "测试原创",
      tags: "旁白",
      refs: [
        {
          work: work.id,
          repo: repo.id,
          project: work.project,
          title: work.title,
        },
      ],
    },
  ];
  const engine = {
    id: randomUUID(),
    name: "本地验收声线",
    enabled: true,
    config: { voice: "fixture" },
    voices: [{ id: "fixture", name: "测试声线" }],
  };
  const state = {
    calls,
    errors,
    repo,
    work,
    chat,
    assets,
    works: [work],
    repos: [repo],
    tasks: [build, turn, queued],
    exports: [
      {
        id: randomUUID(),
        kind: "render",
        state: "cancelled",
        input: { width: 1280, fps: 24 },
        created: now,
      },
    ],
    versions: [
      { id: "a".repeat(40), name: "已确认开场", kind: "git", created: now },
    ],
    failSave: false,
    failList: false,
  };
  const action = async (name, args = {}) => {
    switch (name) {
      case "works_page": {
        if (state.failList) throw Error("验收：目录暂时不可读");
        const items = state.works.filter(
          (w) =>
            (!args.status || w.status === args.status) &&
            (!args.search || w.title.includes(args.search)),
        );
        return { items, total: items.length };
      }
      case "repositories_page":
        return { items: state.repos, total: state.repos.length };
      case "repositories_get":
        return state.repos.find((r) => r.id === args.repo) || repo;
      case "github_accounts":
      case "tools_info":
      case "tokens_list":
      case "oauth_grants":
        return [];
      case "works_open":
        return {
          ...(state.works.find((w) => w.id === args.id) || work),
          repository: repo,
        };
      case "works_tasks":
        return state.tasks;
      case "works_chats":
        return [chat];
      case "connections_list":
        return [connection];
      case "works_chat_turns":
        return state.tasks.filter((t) => t.chat === args.chat);
      case "works_sync_status":
        return {
          branch: work.branch,
          remote: repo.url,
          remoteExists: true,
          ahead: 2,
          behind: 0,
          dirty: 0,
          checked: now,
        };
      case "works_exports":
        return state.exports;
      case "works_versions":
        return state.versions;
      case "works_assets":
        return assets.filter((a) => a.refs.some((r) => r.work === args.id));
      case "assets_list":
        return args.deleted
          ? []
          : assets.filter(
              (a) =>
                (!args.unused || !a.refs.length) &&
                (!args.search || a.name.includes(args.search)),
            );
      case "engines_list":
        return [engine];
      case "works_background":
        return state.tasks.some((t) => t.state === "queued")
          ? [
              {
                ...work,
                tasks: state.tasks.filter((t) => t.state === "queued"),
              },
            ]
          : [];
      case "task_get":
        return {
          task: state.tasks.find((t) => t.id === args.id),
          events:
            args.id === turn.id
              ? [
                  {
                    id: 1,
                    kind: "message",
                    data: {
                      id: "m1",
                      text: "## 修改结果\n**动作已调整**\n1. 加速与减速衔接。\n2. 检查 00:01。\n<script>window.INJECTED=true</script>\n[非法链接](javascript:alert)",
                    },
                  },
                ]
              : [],
        };
      case "works_update":
        if (state.failSave) throw Error("验收：保存失败，输入已保留");
        Object.assign(work, args);
        return work;
      case "works_chat_create":
        return chat;
      case "works_chat_send": {
        const t = {
          id: randomUUID(),
          kind: "agent",
          state: "queued",
          chat: args.chat,
          input: { prompt: args.prompt, context: args.context },
          created: new Date().toISOString(),
        };
        state.tasks.push(t);
        return t;
      }
      case "task_cancel": {
        const t =
          state.tasks.find((t) => t.id === args.id) ||
          state.exports.find((t) => t.id === args.id);
        if (t) t.state = "cancelled";
        return t;
      }
      case "works_task": {
        const t = {
          id: randomUUID(),
          kind: args.kind,
          state: "queued",
          input: args.input || {},
          created: new Date().toISOString(),
        };
        state.tasks.push(t);
        if (t.kind === "render") state.exports.push(t);
        return t;
      }
      case "works_checkpoint": {
        state.versions.unshift({
          id: "b".repeat(40),
          kind: "git",
          name: args.name,
          created: new Date().toISOString(),
        });
        return state.versions[0];
      }
      case "works_version_compare":
        return {
          total: 1,
          changes: [{ status: "M", path: "scene.ts" }],
          note: "包含当前未提交变化；不修改作品",
          truncated: false,
        };
      case "works_version_preview": {
        const t = {
          ...build,
          id: randomUUID(),
          input: { version: args.version },
        };
        state.tasks.push(t);
        return t;
      }
      case "works_restore":
        return { ...work };
      case "works_use_asset": {
        const a = assets.find((a) => a.id === args.asset);
        a.refs.push({
          work: work.id,
          repo: repo.id,
          project: work.project,
          title: work.title,
        });
        return { path: "public/imports/fixture.wav" };
      }
      case "assets_update": {
        const a = assets.find((a) => a.id === args.id);
        Object.assign(a, args);
        return a;
      }
      case "speech_test":
        return {
          task: randomUUID(),
          url: uiUrl + "/api/fixture.wav",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          temporary: true,
        };
      case "works_speech_adopt":
        return { asset: assets[1], adopted: true, resynthesized: false };
      case "repositories_add": {
        const r = { ...repo, id: randomUUID(), name: args.name };
        state.repos.push(r);
        return r;
      }
      case "works_create": {
        const w = { ...work, id: randomUUID(), title: args.title };
        state.works.push(w);
        return w;
      }
      default:
        throw Error("UNMOCKED_ACTION: " + name);
    }
  };
  const updateAll = async () => {
    for (const sub of subscriptions) {
      try {
        sub.route.send(
          JSON.stringify({
            type: "update",
            id: sub.id,
            result: await action(sub.name, sub.args),
          }),
        );
      } catch (error) {
        sub.route.send(
          JSON.stringify({ type: "update", id: sub.id, error: error.message }),
        );
      }
    }
  };
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me")
      return route.fulfill({ json: { admin: true } });
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({
        json: {
          url: playerUrl,
          expires: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (
      url.pathname === "/api/fixture.wav" ||
      /\/api\/assets\/[^/]+\/file/.test(url.pathname)
    )
      return route.fulfill({ contentType: "audio/wav", body: wave() });
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected fixture URL" },
    });
  });
  await context.routeWebSocket("**/api/ws", (route) => {
    route.onMessage(async (text) => {
      const value = JSON.parse(String(text));
      if (value.type === "unsubscribe") {
        for (const s of subscriptions)
          if (s.id === value.id) subscriptions.delete(s);
        return;
      }
      if (value.type === "subscribe") subscriptions.add({ ...value, route });
      else calls.push({ name: value.name, args: value.args });
      try {
        route.send(
          JSON.stringify({
            type: value.type === "subscribe" ? "update" : "result",
            id: value.id,
            result: await action(value.name, value.args),
          }),
        );
        if (
          value.type === "call" &&
          !/(_page|_list|_get|_open|_versions|_assets|_chats|_turns)$/.test(
            value.name,
          )
        )
          await updateAll();
      } catch (error) {
        if (error.message.startsWith("UNMOCKED")) errors.push(error.message);
        route.send(
          JSON.stringify({
            type: value.type === "subscribe" ? "update" : "result",
            id: value.id,
            error: error.message,
          }),
        );
      }
    });
    route.onClose(() => {
      for (const s of subscriptions)
        if (s.route === route) subscriptions.delete(s);
    });
  });
  return state;
}
function wave() {
  const b = Buffer.alloc(44 + 4800);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(4800, 40);
  for (let i = 0; i < 2400; i++)
    b.writeInt16LE(Math.sin((i * Math.PI * 880) / 24000) * 4000, 44 + i * 2);
  return b;
}
