/**
 * The port field of the SSH host form.
 *
 * The dialog used to read it as `parseInt(port, 10) || 22`, which accepted
 * anything and quietly saved something else: "abc" became 22, and so did "0",
 * because zero is falsy. "99999" and "-5" were stored verbatim and only failed
 * later, at connect time, with no hint that the port was the reason (owner
 * report 2026-09-08).
 *
 * So parsing answers three states rather than one number, and the caller shows
 * the difference: a blank field means "the default", a well-formed port in
 * range is that port, and anything else is refused where it was typed.
 */

/** SSH's default port — what a blank field means. */
export const DEFAULT_SSH_PORT = 22;

/** TCP's range. Port 0 is reserved and cannot be connected to. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

export type SshPortParse =
	| { readonly ok: true; readonly port: number }
	| { readonly ok: false };

/**
 * Read the port field.
 *
 * Blank (or whitespace) is the default rather than an error: the field carries
 * a "22" placeholder, and someone who clears it is asking for the default, not
 * making a mistake.
 *
 * Everything else must be digits only. `Number.parseInt` is deliberately not
 * used — it stops at the first non-digit, so "22x", "2 2" and "22.5" would all
 * pass as 22, saving a port the reader did not type.
 */
export function parseSshPort(input: string): SshPortParse {
	const trimmed = input.trim();
	if (trimmed === "") return { ok: true, port: DEFAULT_SSH_PORT };
	if (!/^\d+$/.test(trimmed)) return { ok: false };
	const port = Number(trimmed);
	if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
		return { ok: false };
	}
	return { ok: true, port };
}
