const OPEN_NATIVE_SEARCH_EVENT = "dure:open-native-search";

export function onOpenNativeSearch(
	callback: (initialQuery: string) => void,
): () => void {
	const handler = (event: Event) => {
		const detail = (event as CustomEvent<{ initialQuery?: string }>).detail;
		callback(
			typeof detail?.initialQuery === "string" ? detail.initialQuery : "",
		);
	};
	window.addEventListener(OPEN_NATIVE_SEARCH_EVENT, handler);
	return () => window.removeEventListener(OPEN_NATIVE_SEARCH_EVENT, handler);
}
