import { useEffect } from "react";

export function useTerminalCanvasFontReadiness(
	refreshSurface: () => void,
): void {
	const fontSet = typeof document === "undefined" ? undefined : document.fonts;

	useEffect(() => {
		if (!fontSet) return;
		let disposed = false;
		let observedReady: Promise<FontFaceSet> | null = null;
		const refreshWhenReady = (ready: Promise<FontFaceSet>) => {
			if (observedReady === ready) return;
			observedReady = ready;
			void ready.then(
				() => {
					if (!disposed) refreshSurface();
				},
				() => undefined,
			);
		};
		const onLoadingDone = () => refreshWhenReady(fontSet.ready);
		fontSet.addEventListener("loadingdone", onLoadingDone);
		// A layout paint can finish a font cycle before this passive effect runs,
		// so observe the current promise even when status is already "loaded".
		refreshWhenReady(fontSet.ready);

		return () => {
			disposed = true;
			fontSet.removeEventListener("loadingdone", onLoadingDone);
		};
	}, [fontSet, refreshSurface]);
}
