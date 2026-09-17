// Quick-dispatch pipeline: turns a durable intent (see quickDispatchIntent.ts)
// into a canonical agent run whose pane opens in the active space once the
// spawn completes (pane-less store projection when no space is resolvable or
// the pane cannot open). The exact name and base commit are journaled before
// mutation. A recoverable canonical-run or presentation result leaves that
// same intent pending; terminal failures are journaled without rejecting the
// caller.

import {
	type CanonicalAddAgentPresentationResult,
	type CanonicalAddAgentRunPolicy,
	type CanonicalRunPaneTarget,
	runCanonicalAddAgentPresenting,
	shouldRetryCanonicalAddAgentAction,
	supportsCanonicalAddAgentRun,
} from "@/lib/agents/addAgentCanonicalRun";
import { runRemoteQuickDispatch } from "./quickDispatchRemote";
import { quickDispatchRemoteTarget, sameQuickDispatchRemoteTarget } from "./quickDispatchDefaults";
import { gitExec } from "@/lib/scm/history/git";
import { renameAgentDisplayName } from "@/lib/agents/agentDisplayNameState";
import { resolveAgentLaunchCredential } from "@/lib/agents/agentLaunchCredential";
import { supportsStructuredChat } from "@/lib/agents/providers";
import { resolveQuickDispatchBaseRef } from "@/lib/agents/quickDispatch/quickDispatchBaseRef";
import {
	completeQuickDispatchIntent,
	failQuickDispatchIntent,
	pinQuickDispatchIntentResolution,
	type QuickDispatchIntentFailureV1,
	type QuickDispatchIntentResolutionV1,
	type QuickDispatchIntentV1,
	readQuickDispatchIntents,
} from "@/lib/agents/quickDispatch/quickDispatchIntent";
import {
	deterministicQuickDispatchName,
	repoClaimedAgentNames,
	suggestQuickDispatchName,
} from "@/lib/agents/quickDispatch/quickDispatchNaming";
import {
	publishQuickDispatchProgress,
	type QuickDispatchStage,
} from "@/lib/agents/quickDispatch/quickDispatchProgress";
import {
	buildQuickDispatchPrompt,
	MAX_QUICK_DISPATCH_PROMPT_BYTES,
	quickDispatchPromptByteLength,
} from "@/lib/agents/quickDispatch/quickDispatchPrompt";
import {
	loadRepoBranchState,
	type RepoBranchState,
} from "@/lib/agents/repoBranchLoad";
import { probeSetupCommand, setupShellCommand } from "@/lib/agents/setupRun";
import { listDir, listRemoteDir } from "@/lib/ipc";
import { supportsDureProviderCredentialSpawn } from "@/lib/ipc/dureProviderCredentialProfile";
import { gitExecLocalBounded } from "@/lib/ipc/git";
import {
	defaultBranchName,
	defaultWorktreePath,
	worktreeDirName,
} from "@/lib/scm/worktrees/worktreePlan";
import { agentSpawnInteractionPreference } from "@/lib/workspace/pane/interfaceMode";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import { useStore } from "@/store";
import type { AccountProfile, Agent, Project, SshHostConfig } from "@/types";

const BASE_SHA_RESOLUTION_TIMEOUT_MS = 3000;
const GIT_COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Small Error subclass carrying the failure code the intent journal records.
 *  Internal to this module — callers only ever see the resulting journaled
 *  failure code, never this exception. */
class QuickDispatchError extends Error {
	readonly code: string;

	constructor(code: string, message?: string) {
		super(message ?? code);
		this.name = "QuickDispatchError";
		this.code = code;
	}
}

/** Slice of store state the pipeline reads — kept narrow so tests can fake it
 *  without constructing the full app store. */
interface QuickDispatchRunState {
	projects: readonly Project[];
	agents: readonly Agent[];
	accounts: readonly AccountProfile[];
	sshHosts?: readonly SshHostConfig[];
	/** Only interfaceMode is read; the effective-mode resolver owns parsing. */
	uiPrefs?: { interfaceMode?: unknown };
}

// Dependency surface kept explicit so every stage is testable with fakes.
export interface QuickDispatchRunDependencies {
	readState: () => QuickDispatchRunState;
	suggestName: typeof suggestQuickDispatchName;
	deterministicName: typeof deterministicQuickDispatchName;
	/** Branches and linked worktrees the repository already holds. Naming
	 *  must avoid them too: the spawn saga refuses an existing `agent/<name>`
	 *  branch or `.worktrees/<name>` path as `workspace_identity_conflict`. */
	readRepoBranchState: (project: Project) => Promise<RepoBranchState>;
	/** Adopts the late AI suggestion as the spawned agent's display name;
	 *  creation slug, worktree, branch, and session identity stay immutable. */
	renameDisplayName: (agentId: string, displayName: string) => void;
	resolveBaseRef: (project: Project) => Promise<string>;
	/** Bounded `rev-parse --verify <ref>^{commit}`. An absent result may trigger
	 *  one HEAD resolution; mutation never receives a moving ref. */
	resolveBaseRefSha: (
		project: Project,
		ref: string,
	) => Promise<string | undefined>;
	/** Returns the first pinned name/base/setup authority before mutation. */
	pin: (
		intentId: string,
		resolution: QuickDispatchIntentResolutionV1,
	) => QuickDispatchIntentResolutionV1;
	/** Raw probed command (e.g. "pnpm install"), unwrapped — the pipeline
	 *  applies `setupShellCommand` itself so every caller wraps identically. */
	probeSetup: (project: Project) => Promise<string | null>;
	/** Where the spawned agent's pane should open — the space active at
	 *  presentation time. `null` (no space resolvable) means the run projects
	 *  into the store only and the agent lands in the Spaces unopened list. */
	resolvePaneTarget: () => CanonicalRunPaneTarget | null;
	runCanonical: (
		input: CanonicalAddAgentRunPolicy,
		paneTarget: CanonicalRunPaneTarget | null,
	) => Promise<CanonicalAddAgentPresentationResult>;
	runRemote: typeof runRemoteQuickDispatch;
	/** Live stage reporting for the launcher's progress pill. Best-effort
	 *  presentation only — the pipeline guards every call, so a throwing
	 *  listener can never fail a dispatch. */
	progress: (intent: QuickDispatchIntentV1, stage: QuickDispatchStage) => void;
	complete: (intentId: string) => void;
	fail: (intentId: string, failure: QuickDispatchIntentFailureV1) => void;
	nowMs: () => number;
	delay: (ms: number) => Promise<void>;
}

/** Bounded ref → commit resolution for the default dependencies. Wrapped in
 *  its own try/catch so a rejection (not just a non-zero exit) still yields
 *  `undefined` rather than propagating. */
async function resolveBaseRefShaBounded(
	project: Project,
	ref: string,
): Promise<string | undefined> {
	try {
		const result = await (project.kind === "ssh" ? gitExec(project, ["rev-parse", "--verify", `${ref}^{commit}`]) : gitExecLocalBounded(
			project.path,
			["rev-parse", "--verify", `${ref}^{commit}`],
			BASE_SHA_RESOLUTION_TIMEOUT_MS,
		));
		const sha = result.stdout.trim();
		return result.code === 0 && GIT_COMMIT_SHA.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** The pane target for a fresh dispatch is whatever space is active when the
 *  spawn completes; `null` when no space is resolvable (the presenting runner
 *  then projects into the store only). */
function resolveActiveSpacePaneTarget(): CanonicalRunPaneTarget | null {
	const state = useStore.getState();
	const space = state.spaces.find(
		(candidate) => candidate.id === state.activeSpaceId,
	);
	return space
		? { spaceId: space.id, windowLabel: spaceWindowLabel(space) }
		: null;
}

const defaultDependencies: QuickDispatchRunDependencies = {
	readState: () => useStore.getState(),
	suggestName: suggestQuickDispatchName,
	deterministicName: deterministicQuickDispatchName,
	readRepoBranchState: (project) => loadRepoBranchState(project, useStore.getState().sshHosts),
	renameDisplayName: renameAgentDisplayName,
	resolveBaseRef: (project) =>
		resolveQuickDispatchBaseRef((args, timeoutMs) =>
			project.kind === "ssh" ? gitExec(project, args) : gitExecLocalBounded(project.path, args, timeoutMs),
		),
	resolveBaseRefSha: resolveBaseRefShaBounded,
	pin: pinQuickDispatchIntentResolution,
	probeSetup: (project) => {
		const host = useStore.getState().sshHosts.find((host) => host.id === project.sshHostId);
		if (project.kind === "ssh" && !host) throw new Error("quick_dispatch_ssh_host_unavailable");
		return probeSetupCommand((p) => host ? listRemoteDir(host, p, true) : listDir(p, true), project.path);
	},
	resolvePaneTarget: resolveActiveSpacePaneTarget,
	runCanonical: runCanonicalAddAgentPresenting,
	runRemote: runRemoteQuickDispatch,
	progress: (intent, stage) =>
		publishQuickDispatchProgress({ intentId: intent.intentId, stage }),
	complete: completeQuickDispatchIntent,
	fail: failQuickDispatchIntent,
	nowMs: () => Date.now(),
	delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The most specific machine code a spawn failure carries: the backend
 *  stage's own error code (e.g. `claude_conversation_host_attach_failed`)
 *  when present, then the transport error's code, then the generic bucket.
 *  The journaled code is what the failure banner and any triage reads —
 *  "quick_dispatch_failed" alone hid the real cause for a full evening. */
function quickDispatchFailureCode(cause: unknown): string {
	if (cause instanceof QuickDispatchError) return cause.code;
	if (typeof cause === "object" && cause !== null) {
		const details = (cause as { details?: { errorCode?: unknown } }).details;
		if (typeof details?.errorCode === "string" && details.errorCode) {
			return details.errorCode;
		}
		const code = (cause as { code?: unknown }).code;
		if (typeof code === "string" && code) return code;
	}
	return "quick_dispatch_failed";
}

/** Same-intent spawn retries within one pipeline run. The idempotency key
 *  makes re-applying safe; the bound makes a permanently failing backend
 *  (e.g. a host that dies on every spawn, 2026-08-31) terminate in a
 *  journaled failure instead of a forever-pending intent whose overlay row
 *  spins for tens of minutes. */
const MAX_SAME_INTENT_ATTEMPTS = 3;
const SAME_INTENT_RETRY_DELAY_MS = 1500;

/** Assembles and starts a canonical background run from a durable intent.
 *  Never rejects — every failure, expected or not, marks the intent failed
 *  with a code instead of throwing out of this function. */
export async function runQuickDispatch(
	intent: QuickDispatchIntentV1,
	deps: QuickDispatchRunDependencies = defaultDependencies,
): Promise<void> {
	// Progress is best-effort presentation: a throwing listener must never
	// turn a healthy dispatch into a failure, so every report is guarded.
	const report = (stage: QuickDispatchStage) => {
		try {
			deps.progress(intent, stage);
		} catch {
			// Presentation-only; nothing to recover.
		}
	};
	try {
		const state = deps.readState();
		const project = state.projects.find(
			(candidate) => candidate.id === intent.projectId,
		);
		if (!project) {
			throw new QuickDispatchError("quick_dispatch_project_unavailable");
		}
		if (!sameQuickDispatchRemoteTarget(intent.remoteTarget, quickDispatchRemoteTarget(project, state.sshHosts ?? []))) {
			throw new QuickDispatchError("quick_dispatch_target_changed");
		}
		const useWorktree = intent.useWorktree !== false;
		const credential = resolveAgentLaunchCredential({
			provider: intent.providerId,
			// Legacy intents predate this field and launched on the provider
			// default, so absence must retain that exact behavior rather than
			// following a mutable global account pointer during boot resume.
			requestedAccountId: intent.accountId ?? null,
			accounts: state.accounts,
		});
		if (
			credential.account &&
			!supportsDureProviderCredentialSpawn(intent.providerId)
		) {
			throw new QuickDispatchError("quick_dispatch_capability_unavailable");
		}
		const prompt = buildQuickDispatchPrompt(
			intent.promptText,
			intent.attachmentPaths,
		);
		if (
			quickDispatchPromptByteLength(prompt) > MAX_QUICK_DISPATCH_PROMPT_BYTES
		) {
			throw new QuickDispatchError("quick_dispatch_prompt_too_large");
		}
		// Pin deterministic identity in every language; AI naming only updates
		// the display title after launch and never delays worktree creation.
		let suggestedDisplayName: Promise<string> | null = null;
		let agentName = intent.resolvedName ?? intent.typedName ?? "";
		if (!agentName) {
			// Isolated launches must also avoid branches and worktrees left by
			// deleted agents. Project-root launches only need an unused agent name.
			const takenNames = [
				...state.agents
					.filter((agent) => agent.projectId === project.id)
					.map((agent) => agent.name),
				...(useWorktree
					? repoClaimedAgentNames(
							await deps.readRepoBranchState(project),
							project.path,
						)
					: []),
			];
			// ponytail: remote naming uses the deterministic name until a remote naming API exists.
			suggestedDisplayName = project.kind === "ssh" ? null : deps.suggestName({
				prompt: intent.promptText,
				providerId: intent.providerId,
				projectPath: project.path,
				takenNames,
			}).catch(() => "");
			agentName = deps.deterministicName({
				prompt: intent.promptText,
				providerId: intent.providerId,
				takenNames,
			});
		}

		// Resolve (or reuse) every derived launch input before the destructive
		// boundary, then let the journal's first writer choose the authority. A
		// crash between here and `deps.complete` must resume onto the exact
		// same request instead of re-deriving a possibly different one.
		let baseSha = useWorktree ? intent.resolvedBaseSha : null;
		if (useWorktree && !baseSha) {
			const resolvedRef = await deps.resolveBaseRef(project);
			baseSha = await deps.resolveBaseRefSha(project, resolvedRef);
			if (!baseSha && resolvedRef !== "HEAD") {
				baseSha = await deps.resolveBaseRefSha(project, "HEAD");
			}
			if (!baseSha) {
				throw new QuickDispatchError("quick_dispatch_base_commit_unavailable");
			}
		}
		// Every dispatch lands on the PTY surface — the same single authority
		// every other spawn entry point reads.
		const interactionPreference = agentSpawnInteractionPreference();
		let setupCommand = useWorktree ? intent.resolvedSetupCommand : null;
		if (setupCommand === undefined) {
			// A PTY-pinned dispatch runs in a terminal regardless of provider,
			// so it probes setup exactly like the native-only providers do.
			const probed =
				intent.runSetup === false ||
				(supportsStructuredChat(intent.providerId) && !interactionPreference)
					? null
					: await deps.probeSetup(project);
			setupCommand = probed ? setupShellCommand(probed) : null;
		}
		const pinned = deps.pin(intent.intentId, {
			resolvedName: agentName,
			resolvedBaseSha: baseSha ?? null,
			resolvedSetupCommand: setupCommand,
		});
		agentName = pinned.resolvedName;
		baseSha = pinned.resolvedBaseSha;
		setupCommand = pinned.resolvedSetupCommand;

		const branch = defaultBranchName(agentName);
		const paneTarget = deps.resolvePaneTarget();
		report("spawning");
		const runPolicy: CanonicalAddAgentRunPolicy = {
			project,
			agentName,
			provider: intent.providerId,
			accountId: credential.accountId ?? null,
			...(credential.account ? { account: credential.account } : {}),
			useWorktree,
			...(useWorktree && baseSha
				? { worktreePlan: {
					branch,
					mode: "new-branch",
					action: "create-new-branch",
					worktreePath: defaultWorktreePath(
						project.path,
						worktreeDirName(branch),
					),
					baseRef: baseSha,
					branchExists: false,
				} }
				: {}),
			setupCommand,
			actionId: intent.intentId,
			prompt,
			...(intent.model ? { model: intent.model } : {}),
			...(intent.effort ? { effort: intent.effort } : {}),
			...(intent.permissionOverride
				? { permissionOverride: intent.permissionOverride }
				: {}),
			...(interactionPreference ? { interactionPreference } : {}),
		} as const;
		if (project.kind === "local" && !supportsCanonicalAddAgentRun(runPolicy)) {
			throw new QuickDispatchError("quick_dispatch_capability_unavailable");
		}
		// Bounded same-intent retry: the backend saga is idempotent on
		// actionId, so re-running is convergent. Exhausting the bound falls
		// through to the journaled failure below — a spawn that fails every
		// time must end as a visible failure, never a forever-pending row.
		let spawnedAgentId: string | undefined;
		for (let attempt = 1; ; attempt += 1) {
			try {
				spawnedAgentId = project.kind === "ssh"
					? (await deps.runRemote(runPolicy, paneTarget, intent.remoteTarget!)).id
					: (await deps.runCanonical(runPolicy, paneTarget))?.run?.agentId;
				break;
			} catch (cause) {
				if (
					!shouldRetryCanonicalAddAgentAction(cause) ||
					attempt >= MAX_SAME_INTENT_ATTEMPTS
				) {
					throw cause;
				}
				await deps.delay(SAME_INTENT_RETRY_DELAY_MS);
			}
		}
		deps.complete(intent.intentId);
		report("done");
		if (suggestedDisplayName && spawnedAgentId) {
			// Fire-and-forget: the dispatch is already complete; a late (or
			// failed) suggestion only means the deterministic slug stays.
			void suggestedDisplayName
				.then((displayName) => {
					if (displayName && displayName !== agentName) {
						deps.renameDisplayName(spawnedAgentId, displayName);
					}
				})
				.catch(() => {});
		}
	} catch (cause) {
		// Journaling the failure must never itself become a rejection — the
		// intent journal (quickDispatchIntent.ts) can throw on storage edge
		// cases (not-found / too-large / commit-failed / storage-unavailable),
		// and `runQuickDispatch`'s contract is "always resolves" (see module
		// header). Log and swallow rather than propagate, matching
		// delegateOnceRuntime.ts's resume guard and spawnResume.ts's
		// finishStale guard.
		try {
			deps.fail(intent.intentId, {
				code: quickDispatchFailureCode(cause),
				message: cause instanceof Error ? cause.message : String(cause),
				atMs: deps.nowMs(),
			});
		} catch (journalCause) {
			console.error(
				`[quickDispatch] failed to journal failure for ${intent.intentId}`,
				journalCause,
			);
		}
		report("failed");
	}
}

/** Dependency surface for boot resume, separate from the run pipeline's own
 *  dependencies so tests can inject a fake `run` without the internal-call
 *  aliasing problem of spying on this module's own export. */
export interface QuickDispatchResumeDependencies {
	readIntents: () => readonly QuickDispatchIntentV1[];
	run: (intent: QuickDispatchIntentV1) => Promise<void>;
}

const defaultResumeDependencies: QuickDispatchResumeDependencies = {
	readIntents: readQuickDispatchIntents,
	run: runQuickDispatch,
};

// React.StrictMode (src/main.tsx) double-invokes the boot effect that calls
// this function, and the two invocations run concurrently — without a guard,
// both would read the same pending intent and each derive its own AI name,
// producing two different idempotency keys and a double spawn. Mirrors
// spawnResume.ts's `ranThisBoot`: the check-then-set below is synchronous (no
// await before it), so the second call always observes the flag already set
// by the time it runs, regardless of how the two calls are interleaved.
let ranThisBoot = false;

/** Boot resume: re-runs whatever quick-dispatch intent was still pending when
 *  the app last closed. Sequential, not parallel — quick-dispatch runs are
 *  rare and this keeps naming/base-ref probes from contending with each
 *  other. Age is not lifecycle authority: every pending intent is offered to
 *  the canonical Run, which decides whether it completed, can continue, or
 *  failed. Runs at most once per boot (see `ranThisBoot` above).
 *
 *  Every per-intent step is individually guarded: one intent's rejection
 *  (or journal-write throw) must never abort the rest of this boot's resume
 *  queue, matching delegateOnceRuntime.ts's per-intent try/catch and
 *  spawnResume.ts's per-receipt guards around `resume`/`finishStale`. */
export async function resumeInterruptedQuickDispatchIntents(
	deps: QuickDispatchResumeDependencies = defaultResumeDependencies,
): Promise<void> {
	if (ranThisBoot) return;
	ranThisBoot = true;
	for (const intent of deps.readIntents()) {
		if (intent.state !== "pending") continue;
		try {
			await deps.run(intent);
		} catch (cause) {
			// runQuickDispatch already journals its own failures; this only
			// guards against an unexpected rejection reaching the loop anyway
			// (e.g. a synchronous throw before the journal write, or a fake in
			// tests) so it can never starve the remaining pending intents.
			console.error(
				`[quickDispatch resume] ${intent.intentId} resume failed`,
				cause,
			);
		}
	}
}

/** Test hook: allow a fresh once-per-boot window. */
export function resetQuickDispatchResumeForTest(): void {
	ranThisBoot = false;
}
