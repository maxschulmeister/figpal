// The threads of the file: open, rename, archive.

import type { ConversationId } from "@earendil-works/pi-durable";
import { AlertDialog, Button, Dialog, DropdownMenu, EllipsisIcon, IconButton, Input, Text } from "figma-kit";
import { type FormEvent, useState } from "react";
import { type ThreadInfo, type ThreadList as List, sortedThreads } from "./threads";

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
	onOpen(id: ConversationId): void;
	onRename(id: ConversationId, title: string): void;
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

export function ThreadList({ list, onOpen, onRename, onArchive }: Props) {
	const [renaming, setRenaming] = useState<ThreadInfo>();
	const [archiving, setArchiving] = useState<ThreadInfo>();

	return (
		<>
			<ul className="flex flex-col py-1">
				{sortedThreads(list).map((thread) => (
					<li
						key={thread.id}
						className={`group flex items-center gap-2 pr-2 hover:bg-hover ${thread.id === list.current ? "bg-selected" : ""}`}
					>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-baseline gap-2 py-2 pl-4 text-left"
							onClick={() => onOpen(thread.id)}
						>
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
										<DropdownMenu.Item onClick={() => setRenaming(thread)}>Rename…</DropdownMenu.Item>
										<DropdownMenu.Item onClick={() => setArchiving(thread)}>Archive…</DropdownMenu.Item>
									</DropdownMenu.Popup>
								</DropdownMenu.Positioner>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</li>
				))}
			</ul>
			{renaming && (
				<RenameDialog
					thread={renaming}
					onClose={() => setRenaming(undefined)}
					onRename={(title) => onRename(renaming.id, title)}
				/>
			)}
			<AlertDialog.Root open={archiving !== undefined} onOpenChange={(open) => open || setArchiving(undefined)}>
				<AlertDialog.Portal>
					<AlertDialog.Backdrop />
					<AlertDialog.Popup placement="center">
						<AlertDialog.Title>Archive “{threadTitle(archiving)}”?</AlertDialog.Title>
						<AlertDialog.Description>The chat leaves the list of this file. A running answer stops.</AlertDialog.Description>
						<AlertDialog.Actions>
							<AlertDialog.Close render={<Button />}>Cancel</AlertDialog.Close>
							<AlertDialog.Close render={<Button variant="primary" />} onClick={() => archiving && onArchive(archiving.id)}>
								Archive
							</AlertDialog.Close>
						</AlertDialog.Actions>
					</AlertDialog.Popup>
				</AlertDialog.Portal>
			</AlertDialog.Root>
		</>
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
