/**
 * Which appearance a theme preference means, resolved once for every reader.
 *
 * The rule is small but it must be one rule: the app resolves it after the
 * store hydrates (themePreference.ts), and the boot splash resolves it before
 * any of that exists, straight from the persisted JSON. Anything that is not
 * "light" or "system" reads as dark — the app default (uiPrefs.theme), and
 * the safe answer for a value read from storage before it has been validated.
 */
export function resolveDarkAppearance(
	theme: unknown,
	systemDark: boolean,
): boolean {
	if (theme === "light") return false;
	if (theme === "system") return systemDark;
	return true;
}
