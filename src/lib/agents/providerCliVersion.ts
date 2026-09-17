/** Channel-independent CLI version parsing for provider update detection.
 * Unparsable input is null and never produces an update signal — no false-positive notices. */

export interface ParsedCliVersion {
	readonly segments: readonly number[];
	/** The matched substring (e.g. "2.1.252"), not the full input. */
	readonly raw: string;
}

const VERSION_PATTERN = /\d+(?:\.\d+)+/;

export function extractCliVersion(
	input: string | null | undefined,
): ParsedCliVersion | null {
	if (!input) return null;
	const match = VERSION_PATTERN.exec(input);
	if (!match) return null;
	return {
		raw: match[0],
		segments: match[0]
			.split(".")
			.map((segment) => Number.parseInt(segment, 10)),
	};
}

export function compareCliVersions(
	a: ParsedCliVersion,
	b: ParsedCliVersion,
): number {
	const length = Math.max(a.segments.length, b.segments.length);
	for (let index = 0; index < length; index += 1) {
		const delta = (a.segments[index] ?? 0) - (b.segments[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}
