// The popup: pair with a FRAME, hand the current page to the AI or take it back.
const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);
const STATES = { online: "已连接", connecting: "正在连接…", offline: "断开了，正在重连…", refused: "连接被拒绝", unpaired: "没有配对" };

let current = null;

async function render(state) {
  if (state.error) return;
  const paired = state.paired && state.status.state !== "unpaired";
  $("pair").hidden = paired;
  $("paired").hidden = !paired;
  if (!paired) {
    if (!$("server").value) $("server").value = state.server || (await defaults()).server || "";
    if (!$("name").value) $("name").value = state.defaultName;
    if (state.status.message) {
      $("pairError").hidden = false;
      $("pairError").textContent = state.status.message;
    }
    return;
  }
  const host = (() => {
    try {
      return new URL(state.server).host;
    } catch {
      return state.server;
    }
  })();
  $("dot").className = `dot ${state.status.state === "online" ? "online" : ""}`;
  const ago = state.heard ? Math.round((Date.now() - state.heard) / 1000) : null;
  $("stateText").textContent = `${STATES[state.status.state] ?? state.status.state} ${host}${state.status.message && state.status.state !== "online" ? `：${state.status.message}` : ""}`;
  $("stateText").title = ago === null ? "" : `${ago} 秒前收到 FRAME 的消息`;
  const repos = state.status.repos ?? [];
  $("repos").textContent = repos.length ? `作品库：${repos.map((repo) => repo.title).join("、")}（这些作品库的 AI 能用这个浏览器里你已经登录的网站）` : "";

  // The page in front: hand it over, or take it back.
  const entry = current && state.tabs.find((tab) => tab.id === current.id);
  const web = current && /^https?:/.test(current.url || "");
  $("currentTitle").textContent = current ? current.title || current.url : "";
  $("shareRow").hidden = Boolean(entry) || !web || !repos.length;
  $("sharedRow").hidden = !entry;
  $("currentKind").textContent = entry ? (entry.kind === "ai" ? "AI 开的" : "已交给 AI") : "";
  $("currentNote").textContent = !web ? "这个页面不是网页，不能交给 AI。" : entry ? "" : "交给 AI 后，它能读这个页面、点击、搜索和下载（不会填密码、发评论或发帖）。";
  $("repo").hidden = repos.length < 2;
  $("repo").replaceChildren(...repos.map((repo) => new Option(repo.title, repo.id)));

  const list = $("tabs");
  list.replaceChildren();
  if (!state.tabs.length) list.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "还没有。AI 打开的网页会出现在单独的窗口里。" }));
  for (const tab of state.tabs) {
    const row = document.createElement("div");
    row.className = "tab";
    const repo = repos.find((item) => item.id === tab.repo)?.title ?? tab.repo;
    row.append(
      Object.assign(document.createElement("span"), { textContent: tab.title || tab.url, title: tab.url }),
      Object.assign(document.createElement("span"), { className: "badge", textContent: `${tab.kind === "ai" ? "AI 开的" : "你交给的"} · ${repo}` }),
    );
    if (tab.kind === "shared") {
      const button = Object.assign(document.createElement("button"), { className: "link", textContent: "收回" });
      button.onclick = async () => render(await ask({ type: "unshare", tab: tab.id }));
      row.append(button);
    }
    list.append(row);
  }
}

/** The FRAME address the zip was downloaded from, to fill in. */
async function defaults() {
  try {
    return await (await fetch(chrome.runtime.getURL("defaults.json"))).json();
  } catch {
    return {};
  }
}

$("connect").onclick = async () => {
  $("pairError").hidden = true;
  const server = $("server").value.trim().replace(/\/+$/, "");
  const code = $("code").value.trim();
  if (!/^https?:\/\//.test(server)) return Object.assign($("pairError"), { hidden: false, textContent: "FRAME 地址要以 https:// 或 http:// 开头" });
  if (!code) return Object.assign($("pairError"), { hidden: false, textContent: "填写配对码" });
  $("connect").disabled = true;
  $("connect").textContent = "正在连接…";
  const state = await ask({ type: "pair", server, code, name: $("name").value.trim() });
  $("connect").disabled = false;
  $("connect").textContent = "连接";
  if (state.status?.state !== "online" && !state.error) Object.assign($("pairError"), { hidden: false, textContent: state.status.message || "没有连上：检查 FRAME 地址和配对码" });
  render(state);
};
$("share").onclick = async () => {
  if (!current) return;
  const repo = $("repo").hidden ? $("repo").options[0]?.value : $("repo").value;
  render(await ask({ type: "share", tab: current.id, repo }));
};
$("unshareCurrent").onclick = async () => current && render(await ask({ type: "unshare", tab: current.id }));
$("reconnect").onclick = async () => render(await ask({ type: "reconnect" }));
$("unpair").onclick = async () => {
  if (!confirm("断开后，FRAME 的 AI 不能再用这个浏览器；要再用时重新配对。")) return;
  render(await ask({ type: "unpair" }));
};

[current] = await chrome.tabs.query({ active: true, currentWindow: true });
render(await ask({ type: "status" }));
