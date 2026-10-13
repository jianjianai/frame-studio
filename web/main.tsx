import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installTouchSupport } from "./lib/touch";
import { prefetch, workPath } from "./lib/api";
import "./theme.css";

installTouchSupport();

// A work page needs the work right after /api/state: ask for both at once (one round trip less).
const work = /^\/work\/([^/]+)\/([^/]+)/.exec(location.pathname);
if (work) prefetch(workPath(decodeURIComponent(work[1]), decodeURIComponent(work[2])) + "?touch=1");

const theme = localStorage.getItem("frame:theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

createRoot(document.getElementById("root")!).render(<App />);
