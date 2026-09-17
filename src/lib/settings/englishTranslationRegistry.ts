export type EnglishTranslationDictionary = Readonly<Record<string, string>>;

export interface NamedEnglishTranslationFragment {
	name: string;
	translations: EnglishTranslationDictionary;
}

/**
 * Compose feature-owned English dictionaries without making import order an
 * implicit conflict-resolution policy.
 */
export function composeEnglishTranslations(
	fragments: readonly NamedEnglishTranslationFragment[],
): EnglishTranslationDictionary {
	const result: Record<string, string> = {};
	const owners = new Map<string, string>();

	for (const fragment of fragments) {
		for (const [key, value] of Object.entries(fragment.translations)) {
			const previousOwner = owners.get(key);
			if (previousOwner !== undefined) {
				throw new Error(
					`Duplicate English translation key ${JSON.stringify(key)} in ${JSON.stringify(previousOwner)} and ${JSON.stringify(fragment.name)}`,
				);
			}
			owners.set(key, fragment.name);
			result[key] = value;
		}
	}

	return Object.freeze(result);
}
