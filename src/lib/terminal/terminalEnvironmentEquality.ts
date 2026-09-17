import type { TerminalEnvironment } from "@/types";

/** Exact key-by-key terminal-environment equality; an absent environment
 * equals an empty one. Extracted from the conversion/rehost/adoption flows
 * that each carried an identical copy. */
export function sameTerminalEnvironment(
	left: TerminalEnvironment | undefined,
	right: TerminalEnvironment,
): boolean {
	const normalizedLeft = left ?? {};
	const keys = new Set([...Object.keys(normalizedLeft), ...Object.keys(right)]);
	return [...keys].every((key) => {
		const variable = key as keyof TerminalEnvironment;
		return normalizedLeft[variable] === right[variable];
	});
}
