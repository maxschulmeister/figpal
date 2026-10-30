// The hosted UI. code.js shows it in the plugin window and gives it Figma's theme class in the URL hash.

import "./style.css";
import { THEME_HASH_KEY } from "@figpal/shared";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createBridge } from "./bridge";

const theme = new URLSearchParams(location.hash.slice(1)).get(THEME_HASH_KEY) ?? "";
document.documentElement.classList.add(...theme.split(" ").filter((name) => name.startsWith("figma-")));

createRoot(document.getElementById("app")!).render(<App bridge={createBridge()} />);
