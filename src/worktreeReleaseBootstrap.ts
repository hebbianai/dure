export {};

async function bootstrap(): Promise<void> {
	const { worktreeReleaseProfile } = await import(
		"@/lib/platform/worktreeReleaseProfile"
	);
	const profile = worktreeReleaseProfile();
	if (profile) {
		const { readWorktreePresentation, completeWorktreePresentation } =
			await import("@/lib/ipc/persistence");
		const { importFirstWorktreePresentation } = await import(
			"@/lib/persistence/worktreePresentationTransfer"
		);
		const { PERSIST_VERSION } = await import(
			"@/lib/persistence/durableAppStoreName"
		);
		const {
			parseWorktreePresentationEnvelope,
			readWorktreePresentationEnvelope,
		} = await import("@/lib/persistence/worktreePresentationEnvelope");
		await importFirstWorktreePresentation(
			profile,
			async () => {
				const read = await readWorktreePresentation();
				const envelope = await readWorktreePresentationEnvelope(
					parseWorktreePresentationEnvelope(read.envelope),
					profile,
				);
				return read.imported ? null : envelope;
			},
			PERSIST_VERSION,
		);
		await completeWorktreePresentation();
	}
	await import("./main");
}

void bootstrap().catch(async (error: unknown) => {
	const [{ default: React }, { default: ReactDOM }, { RenderFailure }] =
		await Promise.all([
			import("react"),
			import("@/lib/platform/reactDomClient"),
			import("./components/AppErrorBoundary"),
		]);
	const container = document.getElementById("root");
	if (container)
		ReactDOM.createRoot(container).render(
			React.createElement(RenderFailure, {
				boundary: "entry",
				error,
				surface: "main",
			}),
		);
});
