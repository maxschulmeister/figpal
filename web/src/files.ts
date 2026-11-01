// Files that tools make for the user, such as exports. They stay in memory until FigPal closes, not in the thread
// (user decision): a thread keeps only their names.

import type { Attachment } from "@figpal/shared";

/** A file in the details of a tool result. */
export type FileRef = { id: string; name: string; mime: string; size: number };
/** The details of a tool result with files. */
export type FileDetails = { files: FileRef[] };

const files = new Map<string, Attachment>();

export function keepFiles(attachments: Attachment[]): FileRef[] {
	return attachments.map((file) => {
		const id = crypto.randomUUID();
		files.set(id, file);
		return { id, name: file.name, mime: file.mime, size: file.bytes.length };
	});
}

/** Undefined after a restart of FigPal. */
export const fileById = (id: string) => files.get(id);

export function downloadFile(file: Attachment) {
	const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime }));
	const link = document.createElement("a");
	link.href = url;
	link.download = file.name;
	link.click();
	// The download reads the URL after the click.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "6 bytes", "1.2 KB", "3.4 MB". */
export function fileSize(bytes: number): string {
	if (bytes < 1000) return `${bytes} bytes`;
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The text for the model about files in a tool result. Empty without files. */
export function filesNote(files: { name: string; size: number }[]): string {
	if (!files.length) return "";
	return `Files for the user to download from this step: ${files.map((file) => `${file.name} (${fileSize(file.size)})`).join(", ")}.`;
}
