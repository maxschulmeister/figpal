// The threads of the file: open, rename, settle, archive. In groups (user requests, like T3 Code's sidebar): Done at the
// top, without a heading; Working, Settled and Archived at the bottom, each folds. Opening an archived thread brings it
// back.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Button, Collapsible, Dialog, DropdownMenu, EllipsisIcon, IconButton, Input, Text } from "figma-kit";
import { type FormEvent, useState } from "react";
import { type ThreadInfo, type ThreadList as List, threadGroups } from "./threads";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

function age(time: number): string {
	const minutes = Math.round((time - Date.now()) / 60_000);
	if (minutes > -60) return relativeTime.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours > -24) return relativeTime.format(hours, "hour");
	return relativeTime.format(Math.round(hours / 24), "day");
}

export const threadTitle = (thread: ThreadInfo | undefined) => thread?.title || "New chat";

type Props = {
	list: List;
	/** The threads with work now: the Working group. */
	working: ReadonlySet<ConversationId>;
	/** Which groups are open: the app keeps it while FigPal is open. */
	openGroups: Record<FoldingGroup, boolean>;
	onOpenGroup(group: FoldingGroup, open: boolean): void;
	onOpen(id: ConversationId): void;
	onRename(id: ConversationId, title: string): void;
	onSettle(id: ConversationId, settled: boolean): void;
	onArchive(id: ConversationId): void;
};

/** A blue dot for a chat that is done and not read. The label is for screen readers. */
export function UnreadDot({ label }: { label: string }) {
	return (
		<span className="size-1.5 shrink-0 self-center rounded-full bg-[var(--figma-color-bg-brand)]">
			<span className="sr-only">{label}</span>
		</span>
	);
}

/** The groups at the bottom of the list, each with a heading that folds. Done is at the top, without a heading. */
const FOLDING = [
	["working", "Working"],
	["settled", "Settled"],
	["archived", "Archived"],
] as const;
export type FoldingGroup = (typeof FOLDING)[number][0];
/** Which groups are open. Archived is folded at first. */
export const OPEN_GROUPS: Record<FoldingGroup, boolean> = { working: true, settled: true, archived: false };

export function ThreadList({ list, working, openGroups, onOpenGroup, onOpen, onRename, onSettle, onArchive }: Props) {
	const [renaming, setRenaming] = useState<ThreadInfo>();
	const groups = threadGroups(list, working);
	const row = (thread: ThreadInfo) =>
		thread.archived ? (
			<li key={thread.id} className="hover:bg-hover">
				<button type="button" className="flex w-full min-w-0 items-baseline gap-2 py-2 pr-10 pl-4 text-left" onClick={() => onOpen(thread.id)}>
					<Text className="truncate text-secondary">{threadTitle(thread)}</Text>
					<Text className="ml-auto shrink-0 text-secondary">{age(thread.updatedAt)}</Text>
				</button>
			</li>
		) : (
			<ThreadRow
				key={thread.id}
				thread={thread}
				open={thread.id === list.current}
				onOpen={onOpen}
				onRename={setRenaming}
				onSettle={onSettle}
				onArchive={onArchive}
			/>
		);

	return (
		// Full height: the folding groups sit at the bottom, like T3 Code's sidebar.
		<div className="flex min-h-full flex-col">
			{groups.done.length > 0 && (
				<section aria-label="Done">
					<ul className="flex flex-col py-1">{groups.done.map(row)}</ul>
				</section>
			)}
			{/* pb-6: the last row stays above the resize grip in the corner. */}
			<div className="mt-auto flex flex-col pt-1 pb-6">
				{FOLDING.map(
					([key, label]) =>
						groups[key].length > 0 && (
							<section key={key} aria-label={label}>
								<Collapsible.Root open={openGroups[key]} onOpenChange={(open) => onOpenGroup(key, open)}>
									{/* figma-kit's trigger is 100% wide: the padding goes around it, else the list scrolls sideways. */}
									<div className="px-2">
										<Collapsible.Trigger>
											{label} ({groups[key].length})
										</Collapsible.Trigger>
									</div>
									{/* Without figma-kit's indent: the rows line up with the Done rows, edge to edge. */}
									<Collapsible.Panel className="ml-0">
										<ul className="flex flex-col">{groups[key].map(row)}</ul>
									</Collapsible.Panel>
								</Collapsible.Root>
							</section>
						),
				)}
			</div>
			{renaming && (
				<RenameDialog
					thread={renaming}
					onClose={() => setRenaming(undefined)}
					onRename={(title) => onRename(renaming.id, title)}
				/>
			)}
		</div>
	);
}

type RowProps = {
	thread: ThreadInfo;
	/** The thread that the chat shows. */
	open: boolean;
	onOpen(id: ConversationId): void;
	onRename(thread: ThreadInfo): void;
	onSettle(id: ConversationId, settled: boolean): void;
	onArchive(id: ConversationId): void;
};

function ThreadRow({ thread, open, onOpen, onRename, onSettle, onArchive }: RowProps) {
	return (
		<li className={`group flex items-center gap-2 pr-2 hover:bg-hover ${open ? "bg-selected" : ""}`}>
			<button type="button" className="flex min-w-0 flex-1 items-baseline gap-2 py-2 pl-4 text-left" onClick={() => onOpen(thread.id)}>
				<Text className="truncate">{threadTitle(thread)}</Text>
				{thread.unread && <UnreadDot label="Unread" />}
				<Text className="ml-auto shrink-0 text-secondary">{age(thread.updatedAt)}</Text>
			</button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					render={<IconButton aria-label={`More for ${threadTitle(thread)}`} className="opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100" />}
				>
					<EllipsisIcon />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Positioner sideOffset={4} align="end">
						<DropdownMenu.Popup style={{ minWidth: 140 }}>
							<DropdownMenu.Item onClick={() => onRename(thread)}>Rename…</DropdownMenu.Item>
							<DropdownMenu.Item onClick={() => onSettle(thread.id, !thread.settled)}>{thread.settled ? "Unsettle" : "Settle"}</DropdownMenu.Item>
							<DropdownMenu.Item onClick={() => onArchive(thread.id)}>Archive</DropdownMenu.Item>
						</DropdownMenu.Popup>
					</DropdownMenu.Positioner>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</li>
	);
}

function RenameDialog({ thread, onClose, onRename }: { thread: ThreadInfo; onClose(): void; onRename(title: string): void }) {
	const [title, setTitle] = useState(thread.title);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onRename(title.trim());
		onClose();
	};
	return (
		<Dialog.Root open onOpenChange={(open) => open || onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop />
				<Dialog.Popup placement="center">
					<Dialog.Header>
						<Dialog.Title>Rename chat</Dialog.Title>
						<Dialog.Controls>
							<Dialog.Close />
						</Dialog.Controls>
					</Dialog.Header>
					<Dialog.Section>
						<form className="flex flex-col gap-3" onSubmit={submit}>
							<Input aria-label="Name" value={title} autoFocus selectOnClick onChange={(event) => setTitle(event.target.value)} />
							<div className="flex justify-end gap-2">
								<Button type="button" onClick={onClose}>
									Cancel
								</Button>
								<Button type="submit" variant="primary" disabled={!title.trim()}>
									Save
								</Button>
							</div>
						</form>
					</Dialog.Section>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
