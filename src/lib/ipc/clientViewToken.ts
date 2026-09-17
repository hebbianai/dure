// Shared client-view token contract: opaque presentation identifiers
// (pane/group/filter/resource ids) exchanged over the client-view protocol.
// A token is a non-empty string of at most 512 UTF-8 bytes with no ASCII
// control characters. Both the IPC transport and the layout projection must
// validate with this single definition so the protocol contract cannot split.
export function validClientViewToken(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		new TextEncoder().encode(value).length > 512
	)
		return false;
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return false;
	}
	return true;
}
