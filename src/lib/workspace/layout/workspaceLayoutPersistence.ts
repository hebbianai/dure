import { terminalDocumentResizePhase } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { subscribeSashDragTransaction } from "@/lib/ui/sashDragHighlight";

interface WorkspaceLayoutSubscription {
	dispose(): void;
}

export interface WorkspaceLayoutPersistenceOptions {
	readonly document: Document;
	readonly onLayoutChange: (
		listener: () => void,
	) => WorkspaceLayoutSubscription;
	readonly onWillMutateLayout: (
		listener: () => void,
	) => WorkspaceLayoutSubscription;
	readonly onDidMutateLayout: (
		listener: () => void,
	) => WorkspaceLayoutSubscription;
	readonly commitOrdinary: () => void;
	readonly captureResizeCommit: () => (() => unknown) | undefined;
}

export function installWorkspaceLayoutPersistence(
	options: WorkspaceLayoutPersistenceOptions,
): () => void {
	let resizeGeneration: number | undefined;
	let commitResize: (() => unknown) | undefined;
	let structuralMutationActive = false;
	const stopResize = subscribeSashDragTransaction(options.document, {
		begin: (generation) => {
			resizeGeneration = undefined;
			commitResize = options.captureResizeCommit();
			if (commitResize) resizeGeneration = generation;
		},
		settle: (generation) => {
			if (generation !== resizeGeneration) return;
			const commit = commitResize;
			resizeGeneration = undefined;
			commitResize = undefined;
			// A pre-HMR sash listener can publish blur/lost-capture settle from its
			// capture listener. Read after the current cancel event reaches Dockview.
			return Promise.resolve().then(() => commit?.());
		},
	});
	const mutationStart = options.onWillMutateLayout(() => {
		structuralMutationActive = true;
	});
	const mutationEnd = options.onDidMutateLayout(() => {
		structuralMutationActive = false;
		if (terminalDocumentResizePhase(options.document) === "idle") {
			options.commitOrdinary();
		}
	});
	const layout = options.onLayoutChange(() => {
		if (
			structuralMutationActive ||
			terminalDocumentResizePhase(options.document) !== "idle"
		) {
			return;
		}
		options.commitOrdinary();
	});
	return () => {
		resizeGeneration = undefined;
		commitResize = undefined;
		structuralMutationActive = false;
		layout.dispose();
		mutationStart.dispose();
		mutationEnd.dispose();
		stopResize();
	};
}
