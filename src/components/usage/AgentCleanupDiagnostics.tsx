import { useEffect, useState, type ReactElement } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { LoadingStatus, PanelStatus } from "@/components/common/PanelStatus";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import {
	inspectLocalAgentIdle,
	type AgentRuntimeIdleInspection,
} from "@/lib/ipc/dureAgentIdle";
import {
	idleObservationReason,
	idleObservationState,
	observedIdleDuration,
} from "@/lib/usage/agentIdleDiagnostics";
import { useStore } from "@/store";

/** Mounted only by the Pro resource widget; a closed dialog owns no reads. */
export function AgentCleanupDiagnostics({
	children,
}: {
	children: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>
			<DialogContent className="max-h-[85dvh] overflow-y-auto bg-popover text-popover-foreground backdrop-blur-none backdrop-saturate-100 dark:bg-popover sm:max-w-xl">
				<DialogHeader className="text-left pr-6">
					<DialogTitle>{t("usage.cleanup.title")}</DialogTitle>
					<DialogDescription>
						{t("usage.cleanup.description")}
					</DialogDescription>
				</DialogHeader>
				{open && <CleanupObservations />}
			</DialogContent>
		</Dialog>
	);
}

type ReadState =
	| { kind: "loading" }
	| { kind: "failed"; detail: string }
	| { kind: "ready"; snapshot: AgentRuntimeIdleInspection };

function CleanupObservations() {
	const [read, setRead] = useState<ReadState>({ kind: "loading" });
	const [revision, setRevision] = useState(0);
	const agents = useStore((state) => state.agents);
	useEffect(() => {
		let alive = true;
		setRead({ kind: "loading" });
		void inspectLocalAgentIdle().then(
			(snapshot) => {
				if (alive) setRead({ kind: "ready", snapshot });
			},
			(error: unknown) => {
				if (alive) setRead({ kind: "failed", detail: String(error) });
			},
		);
		return () => {
			alive = false;
		};
	}, [revision]);

	return (
		<div className="min-w-0 space-y-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs text-muted-foreground">
					{t("usage.cleanup.local")}
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={read.kind === "loading"}
					onClick={() => setRevision((value) => value + 1)}
				>
					{t("common.refresh")}
				</Button>
			</div>
			{read.kind === "loading" && <LoadingStatus className="min-h-32" />}
			{read.kind === "failed" && (
				<PanelStatus role="alert" className="min-h-32 items-start">
					<p>{t("usage.cleanup.loadFailed")}</p>
					<p className="max-w-full break-words font-mono text-xs">
						{read.detail}
					</p>
				</PanelStatus>
			)}
			{read.kind === "ready" && (
				<>
					<div className="space-y-2">
						<p>
							{read.snapshot.configuration === "enabled"
								? t("usage.cleanup.enabled", {
										duration: observedIdleDuration(read.snapshot.afterMs),
									})
								: t(
										read.snapshot.configuration === "disabled"
											? "usage.cleanup.disabled"
											: "usage.cleanup.invalid",
									)}
						</p>
						<p className="text-xs text-muted-foreground">
							{t("usage.cleanup.observedAt")}{" "}
							<span className="font-mono">
								{read.snapshot.observedAtMs === null
									? t("usage.cleanup.unobserved")
									: new Date(read.snapshot.observedAtMs).toLocaleString()}
							</span>
						</p>
						<p className="text-xs text-muted-foreground">
							{t(
								read.snapshot.partial
									? "usage.cleanup.partial"
									: "usage.cleanup.lastPage",
							)}
						</p>
						{read.snapshot.reasonCode && (
							<ObservationReason code={read.snapshot.reasonCode} />
						)}
					</div>
					{read.snapshot.agents.length === 0 ? (
						<PanelStatus className="min-h-24">
							<p>{t("usage.cleanup.empty")}</p>
						</PanelStatus>
					) : (
						<ul className="divide-y divide-border border-y border-border">
							{read.snapshot.agents.map((observation, index) => {
								const agent = agents.find(
									(candidate) =>
										candidate.id === observation.agentId &&
										candidate.runtimeBinding?.runtime === "hmux_managed_v1" &&
										candidate.runtimeBinding?.source === "local" &&
										(candidate.runtimeBinding.backendProfileId ?? "local") ===
											"local",
								);
								return (
									<li
										key={`${observation.agentId}:${index}`}
										className="space-y-1.5 py-3"
									>
										{agent && (
											<p className="break-words font-medium">
												{agentDisplayName(agent)}
											</p>
										)}
										<p className="break-all font-mono text-xs text-muted-foreground">
											{observation.agentId}
										</p>
										<div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
											<span>{idleObservationState(observation.state)}</span>
											<span className="text-muted-foreground">
												{t("usage.cleanup.idle")}{" "}
												<span className="font-mono">
													{observedIdleDuration(observation.observedIdleMs)}
												</span>
											</span>
										</div>
										{![
											"observing",
											"protected",
											"hibernate_requested",
										].includes(observation.state) && (
											<p className="break-all font-mono text-xs text-muted-foreground">
												{observation.state}
											</p>
										)}
										{observation.reasonCode && (
											<ObservationReason code={observation.reasonCode} />
										)}
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
		</div>
	);
}

function ObservationReason({ code }: { code: string }) {
	return (
		<div className="text-xs text-muted-foreground">
			<p>{idleObservationReason(code)}</p>
			<details className="mt-1">
				<summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
					{t("usage.cleanup.reasonCode")}
				</summary>
				<p className="mt-1 break-all font-mono">{code}</p>
			</details>
		</div>
	);
}
