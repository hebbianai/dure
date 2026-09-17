/** A text service can replace its last character without composition events.
 * Delete complete code points, then append the new suffix at the terminal. */
export function terminalTextReplacement(
	previousValue: string,
	nextValue: string,
) {
	const previous = [...previousValue];
	const next = [...nextValue];
	let shared = 0;
	while (
		shared < previous.length &&
		shared < next.length &&
		previous[shared] === next[shared]
	)
		shared += 1;
	return {
		deleteBefore: previous.length - shared,
		text: next.slice(shared).join(""),
	};
}
