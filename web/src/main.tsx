// The hosted UI. code.js shows it in the plugin window and gives it Figma's theme class in the URL hash.

import "./style.css";
import { THEME_HASH_KEY } from "@figpal/shared";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createBridge } from "./bridge";
import { ResizeGrip } from "./resize-grip";

const theme = new URLSearchParams(location.hash.slice(1)).get(THEME_HASH_KEY) ?? "";
document.documentElement.classList.add(...theme.split(" ").filter((name) => name.startsWith("figma-")));

// On macOS, Cmd+A selects text through the app's Edit menu, and in Figma Desktop that menu item is Figma's own command.
// The plugin window gets the key, but nothing selects the text: do it here. This also keeps the key from Figma.
addEventListener("keydown", (event) => {
	const field = event.target;
	if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
	if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
	event.preventDefault();
	field.select();
});

const bridge = createBridge();
createRoot(document.getElementById("app")!).render(
	<>
		<App bridge={bridge} />
		<ResizeGrip bridge={bridge} />
	</>,
);
