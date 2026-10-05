import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const theme = localStorage.getItem("frame:theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

createRoot(document.getElementById("root")!).render(<App />);
