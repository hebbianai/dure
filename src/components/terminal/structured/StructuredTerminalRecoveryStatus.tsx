import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, Info } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Titled } from "@/components/ui/tooltip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { usePaneActionPending } from "@/components/workspace/useNamedPaneAction";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TerminalFailureMessageId } from "@/lib/terminal/state/terminalFailurePresentation";
import type {
	TerminalAttachRecovery,
	TerminalAttachWorktreeStatus,
} from "@/lib/terminal/terminalAttachRecovery";

interface StructuredTerminalRecoveryStatusProps {
	readonly paneId?: string;
	readonly error?: string;
	readonly errorMessageId?: TerminalFailureMessageId;
	readonly onDismiss?: () => void;
	readonly attachRecovery?: TerminalAttachRecovery;
	readonly onPresentationChange?: (visible: boolean) => void;
	/** The surface the covered pane paints, so the cover paints the same one
	 *  and the pane does not change colour when its session drops: a terminal
	 *  pane paints surface-terminal (VisibilityRetainedStructuredTerminal), an
	 *  agent chat pane the dockview group's surface-pane. Painting the terminal
	 *  surface over a chat pane drew a tinted box inside it (owner report
	 *  2026-09-14, the second time this cover wore the wrong colour). */
	readonly surface?: "terminal" | "pane";
}

const COVER_SURFACE = {
	terminal: "bg-surface-terminal",
	pane: "bg-surface-pane",
} as const;

/** Owns the user-visible recovery lifecycle without participating in transport. */
export function StructuredTerminalRecoveryStatus({
	paneId,
	error,
	errorMessageId,
	onDismiss,
	attachRecovery,
	onPresentationChange,
	surface = "terminal",
}: StructuredTerminalRecoveryStatusProps) {
	const [resumeState, setResumeState] = useState<
		"idle" | "resuming" | "recreating" | "failed"
	>("idle");
	const [worktreeStatus, setWorktreeStatus] = useState<
		TerminalAttachWorktreeStatus | "inspecting" | "none"
	>("none");
	const [actionFailure, setActionFailure] = useState<{
		readonly operation: "resume" | "recreate";
		readonly detail: string;
	}>();
	const [copiedErrorDetails, setCopiedErrorDetails] = useState(false);
	const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
	const autoResumeAttemptedRef = useRef(false);
	const worktreeRecoveryRef = useRef(attachRecovery?.worktree);
	worktreeRecoveryRef.current = attachRecovery?.worktree;
	const worktreePath = attachRecovery?.worktree?.path;
	const worktreeBranch = attachRecovery?.worktree?.branch;
	const startsFresh = attachRecovery?.intent === "start_fresh";
	const primaryActionName = startsFresh ? "start_fresh" : "resume";
	const rehosting = usePaneActionPending(paneId ?? "", "rehost");
	const replacing = rehosting || attachRecovery?.transitioning === true;
	const recoveryVisible = Boolean(!replacing && error && attachRecovery);
	// Include the ready-to-run render so manual controls cannot flash before
	// the automatic effect starts. Inspection alone keeps its manual escape.
	const automaticResumeReady = Boolean(
		attachRecovery?.automatic &&
			resumeState === "idle" &&
			(worktreePath === undefined ||
				worktreeStatus === "present" ||
				worktreeStatus === "occupied" ||
				worktreeStatus === "unavailable"),
	);
	const recovering =
		automaticResumeReady ||
		resumeState === "resuming" ||
		resumeState === "recreating";
	useLayoutEffect(() => {
		onPresentationChange?.(recoveryVisible);
		return () => {
			if (recoveryVisible) onPresentationChange?.(false);
		};
	}, [onPresentationChange, recoveryVisible]);
	useEffect(() => {
		if (!error || !worktreePath) {
			setWorktreeStatus("none");
			return;
		}
		let current = true;
		setWorktreeStatus("inspecting");
		void worktreeRecoveryRef.current
			?.inspect()
			.then((status) => {
				if (current) setWorktreeStatus(status);
			})
			.catch(() => {
				// Inspection only selects presentation. It never rejects Resume.
				if (current) setWorktreeStatus("unavailable");
			});
		return () => {
			current = false;
		};
	}, [error, worktreePath, worktreeBranch]);
	const resumeAction = useCallback(async () => {
		if (!attachRecovery) throw new Error("recovery unavailable");
		setResumeState("resuming");
		setActionFailure(undefined);
		// Success replaces the session; the pane rebinds through the rehost
		// event machinery, so only the failure needs a local transition back.
		try {
			await attachRecovery.resume();
		} catch (cause) {
			setResumeState("failed");
			setActionFailure({
				operation: "resume",
				detail: cause instanceof Error ? cause.message : String(cause),
			});
			throw cause;
		}
	}, [attachRecovery]);
	const onRecoveryResume = useCallback(() => {
		void resumeAction().catch(() => {});
	}, [resumeAction]);
	const recreateWorktreeAction = useCallback(async () => {
		const worktree = attachRecovery?.worktree;
		if (!attachRecovery || !worktree) {
			throw new Error("worktree recovery unavailable");
		}
		setResumeState("recreating");
		setActionFailure(undefined);
		try {
			await worktree.recreate();
		} catch (cause) {
			setResumeState("failed");
			setActionFailure({
				operation: "recreate",
				detail: cause instanceof Error ? cause.message : String(cause),
			});
			throw cause;
		}
		try {
			await attachRecovery.resume();
		} catch (cause) {
			// Restoration succeeded even if the independent Host launch did not.
			setWorktreeStatus("present");
			setResumeState("failed");
			setActionFailure({
				operation: "resume",
				detail: cause instanceof Error ? cause.message : String(cause),
			});
			throw cause;
		}
	}, [attachRecovery]);
	const onRecreateWorktree = useCallback(() => {
		void recreateWorktreeAction().catch(() => {});
	}, [recreateWorktreeAction]);

	// The button's exact handler doubles as the pane's named action so UI and
	// `dure client pane act` stay one authority with honest action semantics.
	const worktreeMissing = worktreeStatus === "missing";
	usePaneActions(
		JSON.stringify([attachRecovery?.ownerKey, worktreePath, worktreeBranch]),
		paneId ? {
			paneId,
			status: error ? "attach_failed" : "attached",
			...(error ? { error } : {}),
			...(attachRecovery?.context ? { context: attachRecovery.context } : {}),
			actions:
				recoveryVisible && !recovering
					? {
							[primaryActionName]: resumeAction,
							...(worktreeMissing
								? { recreate_worktree: recreateWorktreeAction }
								: {}),
						}
					: {},
		} : undefined,
	);

	// Self-healing resumes once per failure episode. A cleared error arms the
	// next episode, while a failed attempt leaves the manual action available.
	useEffect(() => {
		if (!error) {
			autoResumeAttemptedRef.current = false;
			setResumeState("idle");
			setActionFailure(undefined);
			return;
		}
		if (replacing || !automaticResumeReady || autoResumeAttemptedRef.current) {
			return;
		}
		autoResumeAttemptedRef.current = true;
		onRecoveryResume();
	}, [error, automaticResumeReady, onRecoveryResume, replacing]);

	const errorDetails = [
		attachRecovery?.context,
		attachRecovery?.worktree
			? `worktree=${attachRecovery.worktree.path} branch=${attachRecovery.worktree.branch}`
			: undefined,
		error,
		actionFailure?.detail,
	]
		.filter(Boolean)
		.join("\n");

	const onCopyErrorDetails = useCallback(() => {
		void writeText(errorDetails)
			.then(() => {
				setCopiedErrorDetails(true);
				setTimeout(() => setCopiedErrorDetails(false), 1500);
			})
			.catch(() => {});
	}, [errorDetails]);

	if (!error || replacing) return null;
	if (!attachRecovery) {
		const visibleError = errorMessageId ? t(errorMessageId) : error;
		// Only the failure owner can acknowledge an operation notice. A
		// missing recovery handler does not make a connection failure dismissible.
		return (
			<Alert
				surface="dock"
				className="absolute inset-x-2 top-2 z-20"
				dismiss={
					onDismiss ? { label: t("common.close"), onClick: onDismiss } : undefined
				}
				action={
					<IconButton
						title={t("terminal.recovery.copyDetails")}
						onClick={onCopyErrorDetails}
					>
						{copiedErrorDetails ? <Check /> : <Copy />}
					</IconButton>
				}
			>
				{visibleError}
			</Alert>
		);
	}

	if (recovering) {
		return (
			<PanelStatus
				role="status"
				size="xs"
				className={cn("absolute inset-0 z-10 p-4", COVER_SURFACE[surface])}
			>
				<p>
					{t(
						resumeState === "recreating"
							? "terminal.recovery.recreatingWorktree"
							: startsFresh
								? "common.restarting"
								: "terminal.recovery.resuming",
					)}
				</p>
			</PanelStatus>
		);
	}

	// The pane has no terminal content while detached, so recovery is an
	// inline empty state. It stays centered when it fits and scrolls when short.
	return (
		// The cover paints the surface of the pane it covers (`surface`).
		// surface-pane derives from the app's glass pane and surface-terminal
		// from the scheme's own background: under the default theme the two sit
		// within a hair of each other and a swap is invisible, but under a
		// scheme they are two colours and the pane changed colour the moment
		// its session dropped (owner report 2026-09-14).
		<div className={cn("absolute inset-0 z-10 flex overflow-y-auto", COVER_SURFACE[surface])}>
			<PanelStatus
				role="status"
				size="xs"
				className="m-auto h-auto w-full max-w-md min-w-0 gap-2.5 p-4"
			>
				<p className="text-sm font-medium text-foreground">
					{t(
						worktreeMissing
							? "terminal.recovery.worktreeMissingTitle"
							: "terminal.recovery.title",
					)}
				</p>
				<p className="text-center text-xs leading-5 text-muted-foreground">
					{worktreeMissing
						? t("terminal.recovery.worktreeMissingBody", {
								branch: attachRecovery.worktree?.branch ?? "",
							})
						: t(
								startsFresh
									? "agents.conversation.sessionEnded"
									: "terminal.recovery.body",
							)}
				</p>
				{worktreeMissing && attachRecovery.worktree && (
					<Titled title={attachRecovery.worktree.path}>
						<code
							className="max-w-full truncate rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
						>
							{attachRecovery.worktree.path}
						</code>
					</Titled>
				)}
				<div className="mt-0.5 flex flex-wrap items-center justify-center gap-1.5">
					{worktreeMissing && (
						<Button size="sm" onClick={onRecreateWorktree}>
							{t("terminal.recovery.recreateWorktree")}
						</Button>
					)}
					<Button
						size="sm"
						variant={worktreeMissing ? "outline" : "default"}
						onClick={onRecoveryResume}
					>
						{t(
							startsFresh
								? "agents.conversation.startFresh"
								: worktreeMissing
									? "terminal.recovery.resumeWithoutWorktree"
									: "terminal.recovery.resume",
						)}
					</Button>
					<IconButton
						title={t("terminal.recovery.copyDetails")}
						onClick={onCopyErrorDetails}
					>
						{copiedErrorDetails ? <Check /> : <Copy />}
					</IconButton>
					<IconButton
						title={t("terminal.recovery.viewDetails")}
						pressed={errorDetailsOpen}
						onClick={() => setErrorDetailsOpen((open) => !open)}
					>
						<Info />
					</IconButton>
				</div>
				{resumeState === "failed" && (
					<p className="text-xs text-muted-foreground">
						{t(
							actionFailure?.operation === "recreate"
								? "terminal.recovery.worktreeRecreateFailed"
								: "terminal.recovery.resumeFailed",
						)}
					</p>
				)}
				{errorDetailsOpen && (
					<pre className="max-h-48 w-full min-w-0 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-2.5 text-left text-[11px] leading-4 break-words whitespace-pre-wrap text-muted-foreground select-text">
						{errorDetails}
					</pre>
				)}
			</PanelStatus>
		</div>
	);
}
