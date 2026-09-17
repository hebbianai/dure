import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { onOpenNativeSearch } from "@/lib/search/nativeSearchBus";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { useStore } from "@/store";
import type { NativeSearchDialogRequest } from "@/components/search/NativeSearchDialog";

const NativeSearchDialog = lazy(() =>
	import("@/components/search/NativeSearchDialog").then((module) => ({
		default: module.NativeSearchDialog,
	})),
);

/** Keep the native-search catalog and source adapters out of cold startup.
 * This tiny launcher owns every activation path so an event cannot disappear
 * while the dialog chunk is still loading. */
export function LazyNativeSearchDialog() {
	const revision = useRef(0);
	const [request, setRequest] = useState<NativeSearchDialogRequest>();
	const activate = useCallback((initialQuery: string) => {
		revision.current += 1;
		setRequest({ revision: revision.current, initialQuery });
	}, []);

	useEffect(() => onOpenNativeSearch(activate), [activate]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const chord = shortcutChord(
				"native-search",
				useStore.getState().shortcutOverrides,
			);
			if (!matchesChord(chord, event) || shouldYieldToTerminal()) return;
			event.preventDefault();
			activate("");
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [activate]);

	if (!request) return null;
	return (
		<Suspense
			fallback={
				<div
					role="status"
					className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] text-xs text-muted-foreground"
				>
					{t("common.loading")}
				</div>
			}
		>
			<NativeSearchDialog request={request} />
		</Suspense>
	);
}
