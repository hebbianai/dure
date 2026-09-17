export function containsCliControlCharacter(
	value: string,
	options: { allowLayout?: boolean; rejectC1?: boolean } = {},
): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		const allowedLayout =
			options.allowLayout === true && (code === 9 || code === 10 || code === 13);
		if (
			(code < 32 && !allowedLayout) ||
			code === 127 ||
			(options.rejectC1 === true && code >= 128 && code <= 159)
		) {
			return true;
		}
	}
	return false;
}
