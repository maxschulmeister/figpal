// Selection chips in the composer: the Figma selection goes into the text as a chip at the caret.
// - A chip has exactly one space before it and after it, if there is text or a chip next to it.
// - A new selection inserts a chip at the caret. If the caret is right after a chip and its space (nothing typed after
//   it, or the user clicked it), the selection replaces that chip, and an empty selection removes it.
// - Backspace or Delete next to a chip, or next to its space, removes the chip and its space.
// - Highlighted text stays: the chip goes after it. A caret inside a word puts the chip after the word.
// - Selections that figma_execute code makes add no chip.

import { defaultDirectiveFormatter, type TextMessagePartComponent } from "@assistant-ui/react";
import { $createDirectiveNodeWithFormatter, $isDirectiveNode, DirectiveNode } from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import type { FileInfo } from "@figpal/shared";
import {
	$createTextNode,
	$getNearestNodeFromDOMNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	$isTextNode,
	CLICK_COMMAND,
	COMMAND_PRIORITY_NORMAL,
	KEY_ARROW_LEFT_COMMAND,
	KEY_ARROW_RIGHT_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
	type LexicalNode,
	SKIP_DOM_SELECTION_TAG,
	TextNode,
} from "lexical";
import { useEffect, useState } from "react";
import type { Bridge } from "./bridge";
import { CHIP_TYPE, chipItem, chipSegments, QUOTE_TYPE, readChip } from "./node-chips";

/**
 * The chip next to a collapsed caret (before it, or after it), or the selected chip. With `space`, a space between the
 * chip and the caret counts as nothing typed.
 */
function $chipBeside(backward: boolean, space: boolean): DirectiveNode | null {
	const selection = $getSelection();
	let node: LexicalNode | null | undefined;
	if ($isNodeSelection(selection)) {
		const nodes = selection.getNodes();
		node = nodes.length === 1 ? nodes[0] : null;
	} else if ($isRangeSelection(selection) && selection.isCollapsed()) {
		const { anchor } = selection;
		const at = anchor.getNode();
		if ($isTextNode(at)) {
			const text = at.getTextContent();
			const between = backward ? text.slice(0, anchor.offset) : text.slice(anchor.offset);
			if (between === "" || (space && between === " ")) node = backward ? at.getPreviousSibling() : at.getNextSibling();
		} else if ($isElementNode(at)) node = at.getChildAtIndex(backward ? anchor.offset - 1 : anchor.offset);
	}
	return $isChip(node) ? node : null;
}

function $isChip(node: LexicalNode | null | undefined): node is DirectiveNode {
	if (!$isDirectiveNode(node)) return false;
	const { type, id } = node.getDirectiveItem();
	return type === CHIP_TYPE && readChip(id) !== undefined;
}

/** Sets the spaces at one end of a text node next to a chip to exactly one. The caret stays at its place in the text. */
function $oneSpace(node: TextNode, atStart: boolean) {
	const text = node.getTextContent();
	const spaces = (atStart ? /^ */ : / *$/).exec(text)![0].length;
	if (spaces === 1) return;
	const next = atStart ? ` ${text.slice(spaces)}` : `${text.slice(0, text.length - spaces)} `;
	const selection = $getSelection();
	const points = $isRangeSelection(selection) ? [selection.anchor, selection.focus].filter((point) => point.key === node.getKey()) : [];
	const offsets = points.map((point) => point.offset);
	node.setTextContent(next);
	points.forEach((point, index) => {
		const offset = offsets[index]!;
		// Text typed at the start of the node moves with it. A caret at the end stays before an added space.
		const moved = atStart ? (offset === 0 ? 0 : Math.max(1, offset - spaces + 1)) : Math.min(offset, next.length);
		point.set(node.getKey(), moved, "text");
	});
}

/** One space between the chip and the text or chip next to it, on each side. */
function $spaceAround(chip: DirectiveNode) {
	const before = chip.getPreviousSibling();
	if ($isTextNode(before)) $oneSpace(before, false);
	else if ($isChip(before)) chip.insertBefore($createTextNode(" "));
	const after = chip.getNextSibling();
	if ($isTextNode(after)) $oneSpace(after, true);
	else if ($isChip(after)) chip.insertAfter($createTextNode(" "));
}

/** The chip that a new selection replaces: the chip before the caret (only its space between), or the selected chip. */
const $chipAtCaret = () => $chipBeside(true, true);

/** Puts the caret after the chip and its space. At the end of the text, the space is there for the next word. */
function $caretAfter(chip: DirectiveNode) {
	const after = chip.getNextSibling();
	const next = $isTextNode(after) ? after : $createTextNode(" ");
	if (next !== after) chip.insertAfter(next);
	$oneSpace(next, true);
	next.select(1, 1);
}

/** Removes the chip and the space after it. The space before it stays between the words. */
function $removeChip(chip: DirectiveNode) {
	const after = chip.getNextSibling();
	chip.remove();
	if ($isTextNode(after) && after.getTextContent().startsWith(" ")) after.spliceText(0, 1, "", true);
}

type Selected = Pick<FileInfo, "page" | "selection" | "selectionCount">;

function $applySelection({ selection: nodes, page, selectionCount }: Selected) {
	// Without a caret (the field never had focus), the chip goes at the end.
	const selection = $getSelection();
	if (!selection) $getRoot().selectEnd();
	// Highlighted text stays: the chip goes after it.
	else if ($isRangeSelection(selection) && !selection.isCollapsed()) {
		const { key, offset, type } = selection.isBackward() ? selection.anchor : selection.focus;
		selection.anchor.set(key, offset, type);
		selection.focus.set(key, offset, type);
	}
	// A caret inside a word moves to the end of the word, so the chip does not split it.
	const caret = $getSelection();
	const at = $isRangeSelection(caret) && caret.isCollapsed() ? caret.anchor : null;
	const node = at?.getNode();
	if (at && $isTextNode(node) && /\S/.test(node.getTextContent()[at.offset - 1] ?? "")) {
		const text = node.getTextContent();
		const space = text.slice(at.offset).search(/\s/);
		const end = space === -1 ? text.length : at.offset + space;
		node.select(end, end);
	}
	const current = $chipAtCaret();
	if (nodes.length === 0) {
		if (current) $removeChip(current);
		return;
	}
	const chip = $createDirectiveNodeWithFormatter(chipItem(nodes, page, selectionCount), defaultDirectiveFormatter);
	if (current) current.replace(chip);
	else $getSelection()?.insertNodes([chip]);
	// The next selection replaces the chip, until the user types.
	$caretAfter(chip);
}

/** A Lexical plugin of the composer. `initial` is the selection when the composer opens. */
export function SelectionChips({ bridge, initial }: { bridge: Pick<Bridge, "onEvent">; initial: Selected }) {
	const [editor] = useLexicalComposerContext();
	// The selection when the composer opens, once.
	const [first] = useState(initial);

	// When the user is in Figma, the update must not move the focus to the plugin window.
	useEffect(() => {
		const apply = (selected: Selected) => {
			const focused = document.hasFocus() && editor.getRootElement() === document.activeElement;
			editor.update(() => $applySelection(selected), focused ? undefined : { tag: SKIP_DOM_SELECTION_TAG });
		};
		if (first.selection.length) apply(first);
		return bridge.onEvent((event) => {
			if (event.type === "selection" && !event.byAgent) apply(event);
		});
	}, [editor, bridge, first]);

	// Backspace and Delete next to a chip remove it with its space, as an empty selection does. Chrome cannot move the
	// caret over a chip, so the arrow keys jump over it, as over one character.
	useEffect(() => {
		const remove = (backward: boolean) => (event: KeyboardEvent | null) => {
			const chip = $chipBeside(backward, true);
			if (!chip) return false;
			event?.preventDefault();
			$removeChip(chip);
			return true;
		};
		const move = (backward: boolean) => (event: KeyboardEvent) => {
			const chip = event.shiftKey || !$isRangeSelection($getSelection()) ? null : $chipBeside(backward, false);
			if (!chip) return false;
			event.preventDefault();
			if (backward) chip.selectPrevious();
			else chip.selectNext(0, 0);
			return true;
		};
		// A click on a chip puts the caret after it, so the next selection replaces it.
		const click = (event: MouseEvent) => {
			const target = event.target;
			const node = target instanceof Element && target.closest(".node-chip") ? $getNearestNodeFromDOMNode(target) : null;
			if (!$isChip(node)) return false;
			$caretAfter(node);
			return true;
		};
		return mergeRegister(
			editor.registerCommand(CLICK_COMMAND, click, COMMAND_PRIORITY_NORMAL),
			editor.registerCommand(KEY_BACKSPACE_COMMAND, remove(true), COMMAND_PRIORITY_NORMAL),
			editor.registerCommand(KEY_DELETE_COMMAND, remove(false), COMMAND_PRIORITY_NORMAL),
			editor.registerCommand(KEY_ARROW_LEFT_COMMAND, move(true), COMMAND_PRIORITY_NORMAL),
			editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, move(false), COMMAND_PRIORITY_NORMAL),
		);
	}, [editor]);

	// The spaces next to chips: after each change of a chip, or of the text next to one.
	useEffect(
		() =>
			mergeRegister(
				editor.registerNodeTransform(DirectiveNode, (chip) => {
					if ($isChip(chip)) $spaceAround(chip);
				}),
				editor.registerNodeTransform(TextNode, (node) => {
					const before = node.getPreviousSibling();
					const after = node.getNextSibling();
					if ($isChip(before)) $spaceAround(before);
					if ($isChip(after)) $spaceAround(after);
				}),
			),
		[editor],
	);

	// Marks the chip that the next selection replaces.
	useEffect(() => {
		let marked: HTMLElement | null = null;
		return editor.registerUpdateListener(({ editorState }) => {
			const key = editorState.read(() => $chipAtCaret()?.getKey());
			const element = key ? editor.getElementByKey(key) : null;
			if (element === marked) return;
			marked?.removeAttribute("data-active");
			element?.setAttribute("data-active", "");
			marked = element;
		});
	}, [editor]);

	return null;
}

/** A chip: the name of the selected layer, or the count and the type of the layers ("2 Frames", "5 Nodes"). */
export function NodeChip({ label }: { label: string }) {
	return <span className="node-chip">{label}</span>;
}

/** A chip of the composer: a layer chip, or a quote (Reply). */
export function ComposerChip({ label, directiveType }: { label: string; directiveType: string }) {
	return directiveType === QUOTE_TYPE ? <span className="quote-chip">{label}</span> : <NodeChip label={label} />;
}

/** The text of a sent message, with its chips. A quote is a block: the line breaks around it are its own. */
export const ChipText: TextMessagePartComponent = ({ text }) =>
	chipSegments(text).map((segment, index, all) => {
		if (segment.kind === "quote")
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: the segments of a sent message do not change.
				<blockquote key={index} className="quote-block">
					{segment.text}
				</blockquote>
			);
		// biome-ignore lint/suspicious/noArrayIndexKey: the segments of a sent message do not change.
		if (segment.kind === "chip") return <NodeChip key={index} label={segment.label} />;
		let value = segment.text;
		if (all[index - 1]?.kind === "quote") value = value.replace(/^\n/, "");
		if (all[index + 1]?.kind === "quote") value = value.replace(/\n$/, "");
		return value;
	});
