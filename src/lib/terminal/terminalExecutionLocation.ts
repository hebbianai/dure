export type TerminalExecutionLocation =
	| { kind: "local" }
	| { kind: "unknown" }
	| { kind: "ssh"; target: string };

const EXECUTION_LOCATION_PREFIX = "terminal-execution-v1;";
const MAX_TARGET_BYTES = 512;

function decodeHexUtf8(value: string): string | null {
	if (
		value.length % 2 !== 0 ||
		value.length > MAX_TARGET_BYTES * 2 ||
		!/^[0-9a-f]*$/i.test(value)
	) {
		return null;
	}
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Parse the additive OSC 777 projection published by a local session daemon. */
export function parseTerminalExecutionLocation(
	data: string,
): TerminalExecutionLocation | null {
	if (!data.startsWith(EXECUTION_LOCATION_PREFIX)) return null;
	const target = decodeHexUtf8(data.slice(EXECUTION_LOCATION_PREFIX.length));
	if (
		target === null ||
		target.length > 0 &&
			(target.trim() !== target ||
				[...target].some(
					(character) =>
						/\s/.test(character) ||
						character.charCodeAt(0) < 0x20 ||
						character.charCodeAt(0) === 0x7f,
				))
	) {
		return null;
	}
	return target ? { kind: "ssh", target } : { kind: "local" };
}
