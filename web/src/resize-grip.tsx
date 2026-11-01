// The grip in the bottom-right corner of the panel. Figma does not let the user resize a plugin panel, so code.js does
// it (figma.ui.resize), and saves the size. figma-kit has no grip icon, so its IconButton has one.

import { IconButton } from "figma-kit";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { Bridge } from "./bridge";

/** The arrow keys change the size by this many pixels. */
const KEY_STEP = 20;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function ResizeGrip({ bridge }: { bridge: Pick<Bridge, "request"> }) {
	const [supported, setSupported] = useState(true);
	const drag = useRef<{ x: number; y: number; width: number; height: number }>(undefined);
	const frame = useRef(0);
	/** The last size asked for, then the size that code.js set: the window can still have the size before it. */
	const size = useRef<{ width: number; height: number }>(undefined);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);
	if (!supported) return null;

	const resize = (width: number, height: number) => {
		const asked = { width: Math.round(width), height: Math.round(height) };
		size.current = asked;
		return bridge.request("resize", asked).then(
			({ result }) => {
				// An answer to an older request must not undo a newer one.
				if (size.current === asked) size.current = result;
			},
			(error) => {
				// An older code.js does not know the request.
				console.warn("FigPal cannot resize the panel:", error);
				setSupported(false);
			},
		);
	};
	// Screen coordinates: the panel moves under the pointer while it changes its size. A drag starts from the size of
	// the window: code.js can have made an earlier size smaller or larger.
	const start = (event: PointerEvent) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
	};
	const sizeAt = (event: PointerEvent, from: NonNullable<typeof drag.current>) =>
		[from.width + event.screenX - from.x, from.height + event.screenY - from.y] as const;
	const move = (event: PointerEvent) => {
		const from = drag.current;
		if (!from) return;
		const [width, height] = sizeAt(event, from);
		// At most one request for each frame of the screen.
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => void resize(width, height));
	};
	/** The end of a drag: a release sends the last position now, a cancel sends nothing more. */
	const end = (event: PointerEvent, release: boolean) => {
		const from = drag.current;
		cancelAnimationFrame(frame.current);
		drag.current = undefined;
		if (from && release) void resize(...sizeAt(event, from));
	};
	const key = (event: KeyboardEvent) => {
		const arrow = ARROWS[event.key];
		if (!arrow) return;
		event.preventDefault();
		const { width, height } = size.current ?? { width: innerWidth, height: innerHeight };
		void resize(width + arrow[0] * KEY_STEP, height + arrow[1] * KEY_STEP);
	};

	return (
		<IconButton
			aria-label="Resize FigPal"
			className="fixed right-0 bottom-0 z-50 cursor-nwse-resize touch-none text-tertiary"
			onPointerDown={start}
			onPointerMove={move}
			onPointerUp={(event) => end(event, true)}
			onPointerCancel={(event) => end(event, false)}
			onLostPointerCapture={(event) => end(event, false)}
			onKeyDown={key}
		>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
				<path d="M9 3 3 9M9 6 6 9" stroke="currentColor" strokeLinecap="round" />
			</svg>
		</IconButton>
	);
}
