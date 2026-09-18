/** Shared file-reference contract for prompts with attachments: images travel
 * as files (both provider CLIs read them by path), and the delivered text
 * references each saved absolute path explicitly. Quick dispatch and the chat
 * composer assemble through this one builder; splitPromptAttachments is its
 * exact inverse, so the format has one authority. */
export function buildPromptWithAttachments(text, attachmentPaths) {
	const body = text.trim();
	if (attachmentPaths.length === 0) return body;
	const references = attachmentPaths
		.map(
			(path, index) =>
				`Read the attached image ${index + 1} before starting: ${path}`,
		)
		.join("\n");
	return body ? `${body}\n\n${references}` : references;
}

const ATTACHMENT_REFERENCE = /^Read the attached image \d+ before starting: (\/.+)$/;

/** Recovers the user's own text and the referenced attachment paths from a
 * delivered prompt. Only the trailing reference block the builder appends is
 * recognized — a lookalike line inside the body stays visible text — so a
 * message that never carried attachments round-trips unchanged. */
export function splitPromptAttachments(text) {
	const lines = text.split("\n");
	const references = [];
	let end = lines.length;
	while (end > 0) {
		const match = ATTACHMENT_REFERENCE.exec(lines[end - 1]);
		if (!match) break;
		const path = match[1];
		references.unshift({
			path,
			fileName: path.slice(path.lastIndexOf("/") + 1),
		});
		end -= 1;
	}
	if (references.length === 0) return { body: text, attachments: [] };
	return {
		body: lines.slice(0, end).join("\n").trimEnd(),
		attachments: references,
	};
}
