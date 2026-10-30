// Small DOM helpers for the spike page. Phase 1 replaces this page with React and assistant-ui.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { style?: string } = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	const { style, ...rest } = props;
	Object.assign(element, rest);
	if (style) element.setAttribute("style", style);
	for (const child of children) if (child) element.append(child);
	return element;
}

export function section(id: string, title: string, ...children: Child[]): HTMLElement {
	return h("section", {}, h("h2", {}, `${id} ${title}`), ...children);
}

/** A button that shows a busy state and writes errors to the log. */
export function button(label: string, action: () => Promise<unknown> | unknown): HTMLButtonElement {
	const element = h("button", { type: "button" }, label);
	element.onclick = async () => {
		element.disabled = true;
		try {
			await action();
		} catch (error) {
			log(`${label}: ${errorText(error)}`);
		} finally {
			element.disabled = false;
		}
	};
	return element;
}

export function row(...children: Child[]): HTMLDivElement {
	return h("div", { className: "row" }, ...children);
}

const logElement = h("pre", { className: "log" });

export function logView(): HTMLPreElement {
	return logElement;
}

export function log(text: string): void {
	logElement.textContent = `${new Date().toLocaleTimeString()} ${text}\n${logElement.textContent ?? ""}`.slice(0, 20_000);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Clipboard API can be blocked in iframes. A selected textarea and execCommand still work. */
export function copyText(text: string): void {
	const area = h("textarea", { value: text });
	document.body.append(area);
	area.select();
	document.execCommand("copy");
	area.remove();
}
