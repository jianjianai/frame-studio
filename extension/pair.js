// One-click pairing: FRAME's 浏览器 tab opens this page with its address and a fresh pairing code.
// Only pages of that FRAME may open it (web_accessible_resources in the manifest of its zip).
const params = new URLSearchParams(location.hash.slice(1));
const server = params.get("server") || "";
const repo = params.get("repo") || "";
const title = document.getElementById("title");
const detail = document.getElementById("detail");
const host = (() => {
  try {
    return new URL(server).host;
  } catch {
    return "";
  }
})();

if (!host || !params.get("code")) {
  title.textContent = "链接不完整";
  title.className = "error";
  detail.textContent = "回到 FRAME 的「浏览器」标签页，再点一次「一键连接」。";
} else {
  detail.textContent = `${host}${repo ? ` · 作品库「${repo}」` : ""}`;
  const state = await chrome.runtime.sendMessage({ type: "pair", server, code: params.get("code") });
  if (state?.status?.state === "online") {
    title.textContent = "已连接";
    title.className = "ok";
    detail.textContent = `作品库「${repo || host}」的 AI 现在可以用这个浏览器里你已经登录的网站（只在它自己开的标签页和你交给它的页面里）。这个页面马上关闭。`;
    history.replaceState(null, "", location.pathname);
    setTimeout(() => window.close(), 2500);
  } else {
    title.textContent = "没有连上";
    title.className = "error";
    detail.textContent = `${state?.status?.message || state?.error || "连不上 FRAME"}。回到 FRAME 的「浏览器」标签页再点一次「一键连接」。`;
  }
}
