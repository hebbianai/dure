import { useLayoutEffect, useMemo, useState } from "react";
import { TerminalView } from "@/components/terminal/TerminalView";
import { AgentSessionWindowRoot } from "@/components/workspace/AgentSessionWindow";
import { windowFocusQaContext } from "@/lib/ipc/windowFocusQa";
import { requireTerminalProviderFixture } from "@/lib/terminal/qa/terminalProviderFixture";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { useRootDarkClass } from "@/lib/theme/themePreference";
import type { Agent } from "@/types";
import { type WindowContext, WindowFocusReporter } from "./hmuxWindowFocus";

function useWindowFocusReporter(context: WindowContext) {
	const reporter = useMemo(() => new WindowFocusReporter(context), [context]);
	useLayoutEffect(() => {
		void reporter.start();
		return () => reporter.dispose();
	}, [reporter]);
	return reporter;
}

function SmokeWindow({ context }: { context: WindowContext }) {
	const reporter = useWindowFocusReporter(context);

	return (
		<main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
			<header className="flex h-8 shrink-0 items-center border-b border-border px-3 font-mono text-xs">
				Hmux {context.resizeRenderProvider ?? "focus"} QA{" "}
				{context.role.toUpperCase()} · {context.sessionId}
				{context.profile === "external_input" && (
					<input
						aria-label="Session search"
						data-qa-hmux-session-search="true"
						className="ml-auto h-6 w-40 rounded border border-border bg-background px-2"
					/>
				)}
			</header>
			<section className="min-h-0 flex-1">
				<TerminalView
					sessionId={context.sessionId}
					kind="pty"
					binding={hmuxStandaloneBinding(
						context.sessionId,
						context.workspaceId,
					)}
					windowFocusProbe={reporter}
				/>
			</section>
		</main>
	);
}

function LargeViewSmokeWindow({
	agentId,
	context,
	sourceWindowLabel,
	sourcePaneOwnerId,
}: {
	agentId: string;
	context: WindowContext;
	sourceWindowLabel: string;
	sourcePaneOwnerId?: string;
}) {
	const reporter = useWindowFocusReporter(context);

	if (context.role !== "b") {
		throw new Error("large-view QA must run in the detached B window");
	}
	const provider = requireTerminalProviderFixture(context.resizeRenderProvider);
	const agent: Agent = {
		id: agentId,
		name: agentId,
		displayName: `large-view-${provider}`,
		provider,
		projectId: `qa-project-${context.proof.slice(0, 12)}`,
		worktreePath: "/tmp",
		branch: "qa/large-view",
		sessionId: context.sessionId,
		sessionKind: "pty",
		runtimeBinding: hmuxStandaloneBinding(
			context.sessionId,
			context.workspaceId,
		),
	};
	return (
		<AgentSessionWindowRoot
			agentId={agentId}
			sourceWindowLabel={sourceWindowLabel}
			sourcePaneOwnerId={sourcePaneOwnerId}
			windowFocusProbe={reporter}
			agentOverride={agent}
		/>
	);
}

export function HmuxWindowFocusQaRoot() {
	// A QA window is its own WebView root. Apply the shared dark root contract
	// so terminal palettes and design tokens resolve from the same source.
	useRootDarkClass();
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaWindowSmoke");
	const [context, setContext] = useState<WindowContext>();
	const [error, setError] = useState<string>();

	useLayoutEffect(() => {
		if (!proof) return;
		windowFocusQaContext<WindowContext>(proof)
			.then(setContext)
			.catch((reason) => {
				console.error(`[hmux window focus QA context] ${String(reason)}`);
				setError(String(reason));
			});
	}, [proof]);

	if (!proof) {
		return (
			<main className="grid h-screen w-screen place-items-center bg-background font-mono text-xs text-muted-foreground">
				Hmux window focus QA controller
			</main>
		);
	}
	if (error) {
		return (
			<main className="grid h-screen w-screen place-items-center bg-background font-mono text-xs text-destructive">
				{error}
			</main>
		);
	}
	if (!context) {
		return (
			<main className="grid h-screen w-screen place-items-center bg-background font-mono text-xs text-muted-foreground">
				Connecting temporary Hmux session
			</main>
		);
	}
	return <SmokeWindow context={context} />;
}

export function HmuxLargeViewQaRoot({
	agentId,
	sourceWindowLabel,
	sourcePaneOwnerId,
}: {
	agentId: string;
	sourceWindowLabel: string;
	sourcePaneOwnerId?: string;
}) {
	const proof = new URLSearchParams(location.search).get("qaLargeView");
	const [context, setContext] = useState<WindowContext>();
	const [error, setError] = useState<string>();

	useLayoutEffect(() => {
		if (!proof) return;
		windowFocusQaContext<WindowContext>(proof)
			.then(setContext)
			.catch((reason) => {
				console.error(`[hmux large-view QA context] ${String(reason)}`);
				setError(String(reason));
			});
	}, [proof]);

	if (!proof || error) {
		return (
			<main className="grid h-screen w-screen place-items-center bg-background font-mono text-xs text-destructive">
				{error ?? "Missing detached large-view QA proof"}
			</main>
		);
	}
	if (!context) {
		return (
			<main className="grid h-screen w-screen place-items-center bg-background font-mono text-xs text-muted-foreground">
				Connecting detached large-view session
			</main>
		);
	}
	return (
		<LargeViewSmokeWindow
			agentId={agentId}
			context={context}
			sourceWindowLabel={sourceWindowLabel}
			sourcePaneOwnerId={sourcePaneOwnerId}
		/>
	);
}
