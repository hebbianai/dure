import { exportWorktreePresentation } from "@/lib/persistence/worktreePresentationTransfer";
import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";

interface PresentationExportDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(reqId: string, result: unknown, action: string): Promise<unknown>;
	isMainWindow(): boolean;
	flush(): Promise<void>;
	channel?: () => string | undefined;
	export?: () => Promise<string>;
}

export async function dispatchCliWorktreePresentation(
	request: { reqId: string; action: string; params: Record<string, unknown> },
	dependencies: PresentationExportDependencies,
): Promise<boolean> {
	if (request.action !== "worktree.presentation.export") return false;
	if (
		!dependencies.isMainWindow() ||
		!(await dependencies.claim(request.reqId))
	)
		return true;
	let result: unknown;
	try {
		const channel = (dependencies.channel ?? configuredFrontendAppChannel)();
		if (
			!channel?.startsWith("dev-") ||
			request.params.sourceChannel !== channel
		) {
			throw new Error("worktree_presentation_source_channel_mismatch");
		}
		await dependencies.flush();
		result = {
			ok: true,
			schemaVersion: 1,
			sourceChannel: channel,
			serializedValue: await (
				dependencies.export ?? exportWorktreePresentation
			)(),
		};
	} catch (error) {
		result = {
			ok: false,
			error: {
				code: "worktree_presentation_export_failed",
				message:
					error instanceof Error ? error.message : "Presentation export failed",
			},
		};
	}
	await dependencies.complete(request.reqId, result, request.action);
	return true;
}
