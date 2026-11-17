const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** A text is a command attempt when its first token is `/name`. A leading
 * absolute path (`/Users/me/file`) or a lone `//` is ordinary text. The chat
 * composer runs what this accepts, and `dure send` sends it without its header,
 * so both read one rule. */
export function parseSlashCommandDraft(draft) {
	const text = draft.trimStart();
	if (!text.startsWith("/")) return null;
	const match = /^\/(\S*)(?:\s+([\s\S]*))?$/u.exec(text);
	if (!match) return null;
	const name = match[1] ?? "";
	const args = (match[2] ?? "").trim();
	if (name === "") return args ? null : { name, args };
	if (!COMMAND_NAME.test(name)) return null;
	return { name, args };
}
