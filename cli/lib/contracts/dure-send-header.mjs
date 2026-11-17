/** The header `dure send` puts ahead of terminal and chat input, and the title
 * of a tracked message: `[dure send · from AGENT]` inside a registered Agent's
 * managed Session, `[dure send · unregistered]` otherwise, with ` · label NAME`
 * for `--from`. The CLI builds it from the Session it runs in; only the label
 * is the sender's own text. It tells a reader the input came through dure send.
 * It is not an authenticated identity, and a missing header proves nothing.
 * The CLI builds it and the chat timeline reads it through this one module. */
export function formatDureSendHeader({ agentName, label } = {}) {
	const name =
		typeof agentName === "string"
			? agentName.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim()
			: "";
	const parts = ["dure send", name ? `from ${name}` : "unregistered"];
	if (label !== undefined) parts.push(`label ${label}`);
	return `[${parts.join(" · ")}]`;
}

const HEADER =
	/^\[dure send · (?:from (.+?)|unregistered)(?: · label (.+?))?\](?: |\r?\n|$)/u;

/** Recovers the header fields and the text after it. Text that does not start
 * with a header returns null and is shown as written. */
export function splitDureSendHeader(text) {
	const match = typeof text === "string" ? HEADER.exec(text) : null;
	if (!match) return null;
	return {
		agentName: match[1] ?? null,
		label: match[2] ?? null,
		body: text.slice(match[0].length),
	};
}
