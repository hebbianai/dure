import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { RecoveryObservation } from "@/lib/agents/accountRecoveryContract";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import type {
	LatestTurnFailure,
	TurnFailureReason,
} from "@/lib/agents/chat/turnFailureReason";
import {
	DEFAULT_FRESH_WITHIN_SEC,
	decideUsageLimitHandoff,
	observationAfterReportedLimit,
	type UsageLimitHandoffDecision,
} from "@/lib/agents/usageLimitHandoffPolicy";
import {
	type UsageLimitHandoffOutcome,
	usageLimitHandoffState,
} from "@/lib/agents/usageLimitHandoffState";
import { t } from "@/lib/i18n";
import { usageRecent } from "@/lib/ipc";
import { accountUsageObservations } from "@/lib/usage/accountUsageObservations";
import type { AccountProfile, Provider } from "@/types";

/** Actual limit failures outrank an older usage reading for manual suggestions. */
const LIMIT_REASONS: ReadonlySet<TurnFailureReason> = new Set([
	"usage_limit",
	"rate_limit",
]);
const CREDENTIAL_REASONS: ReadonlySet<TurnFailureReason> = new Set([
	"usage_limit",
	"rate_limit",
	"authentication_failed",
]);

/** Accounts the provider itself reported at their limit, keyed
 * `<provider>:<credentialId>`, valued by when. Outranks an older poll so a
 * pane never hops back onto the account it just left. */
const reportedLimitAtSec = new Map<string, number>();

export type UsageLimitHandoffView =
	| { readonly kind: "none" }
	/** This episode was already acted on (here or in a previous mount of
	 * the pane): no recovery action is left; `outcome` says what was done. */
	| { readonly kind: "handled"; readonly outcome?: UsageLimitHandoffOutcome }
	| {
			readonly kind: "failed";
			readonly error: string;
			readonly decision?: UsageLimitHandoffDecision;
	  }
	| { readonly kind: "deciding" }
	| { readonly kind: "decided"; readonly decision: UsageLimitHandoffDecision };

/** Manual account suggestions and the backend's observed automatic outcome.
 * Mounting a conversation never changes its account or sends retained input. */
export function useUsageLimitHandoff({
	agentId,
	provider,
	recovery,
	accountMovesLocked,
	currentCredentialId,
	pool,
	failure,
	performAccountSwitch,
}: {
	readonly agentId: string;
	readonly provider: Provider;
	readonly recovery?: RecoveryObservation | null;
	/** The toolbar switcher's own disabled predicate; while true the pane
	 * neither offers nor performs an account move. */
	readonly accountMovesLocked: boolean;
	readonly currentCredentialId: string | undefined;
	readonly pool: readonly AccountProfile[];
	readonly failure: LatestTurnFailure | undefined;
	readonly performAccountSwitch: (
		credentialId: string,
	) => Promise<AgentCredentialTransitionResult>;
}): {
	readonly view: UsageLimitHandoffView;
	readonly requestHandoff: () => Promise<void>;
} {
	useSyncExternalStore(
		usageLimitHandoffState.subscribe,
		usageLimitHandoffState.revision,
		usageLimitHandoffState.revision,
	);
	const [decision, setDecision] = useState<UsageLimitHandoffDecision>();
	const switchRef = useRef(performAccountSwitch);
	switchRef.current = performAccountSwitch;
	const poolRef = useRef(pool);
	poolRef.current = pool;
	const failureRef = useRef(failure);
	failureRef.current = failure;
	const credentialFailure =
		failure && CREDENTIAL_REASONS.has(failure.reason) ? failure : undefined;
	const episode = credentialFailure
		? usageLimitHandoffState.read(agentId, credentialFailure.createdAtMs)
		: undefined;
	const handled = episode !== undefined && episode.result.kind !== "failed";
	const failureItemId = handled ? undefined : credentialFailure?.itemId;
	const failureReason = credentialFailure?.reason;
	const failureCreatedAtMs = credentialFailure?.createdAtMs;
	const poolKey = pool.map((account) => account.id).join(",");

	useEffect(() => {
		// A new episode (or none) invalidates the previous decision at once,
		// so the banner never offers the account the pane is already on.
		setDecision(undefined);
		if (failureItemId === undefined || failureReason === undefined) return;
		if (
			currentCredentialId !== undefined &&
			failureCreatedAtMs !== undefined &&
			LIMIT_REASONS.has(failureReason)
		) {
			reportedLimitAtSec.set(
				`${provider}:${currentCredentialId}`,
				failureCreatedAtMs / 1000,
			);
		}
		let current = true;
		void usageRecent(5)
			.catch(() => undefined)
			.then((report) => {
				if (!current) return;
				const nowSec = Date.now() / 1000;
				const currentPool = poolRef.current;
				const observations = accountUsageObservations(
					provider,
					report,
					currentPool,
					nowSec,
				).map((observation) => {
					const reportedAt = reportedLimitAtSec.get(
						`${provider}:${observation.credentialId}`,
					);
					return reportedAt !== undefined &&
						nowSec - reportedAt <= DEFAULT_FRESH_WITHIN_SEC
						? observationAfterReportedLimit(observation, reportedAt)
						: observation;
				});
				const next = decideUsageLimitHandoff({
					currentCredentialId,
					pool: currentPool,
					observations,
					nowSec,
				});
				setDecision(next);
			})
			.catch(() => {
				if (current) setDecision(undefined);
			});
		return () => {
			current = false;
		};
	}, [
		agentId,
		provider,
		currentCredentialId,
		poolKey,
		failureItemId,
		failureReason,
		failureCreatedAtMs,
	]);

	const requestHandoff = useCallback(async () => {
		if (accountMovesLocked || !decision) throw new Error("handoff_undecided");
		if (decision.kind === "refused") {
			throw new Error(
				`handoff_refused:${decision.code}: ${decision.nextAction}`,
			);
		}
		const latest = failureRef.current;
		if (!latest) throw new Error("handoff_undecided");
		const attempt = usageLimitHandoffState.begin(agentId, latest.createdAtMs);
		if (!attempt) {
			throw new Error("handoff_already_performed");
		}
		const fromName = poolRef.current.find(
			(account) => account.id === currentCredentialId,
		)?.name;
		try {
			const result = await switchRef.current(decision.targetCredentialId);
			if (result.kind === "completed")
				usageLimitHandoffState.settle(attempt, {
					kind: "completed",
					outcome: {
						...(fromName !== undefined ? { fromName } : {}),
						toName: decision.targetName,
					},
				});
			setDecision(undefined);
		} catch (error) {
			usageLimitHandoffState.settle(attempt, {
				kind: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}, [agentId, currentCredentialId, decision, accountMovesLocked]);

	const outcome =
		episode?.result.kind === "completed" ? episode.result.outcome : undefined;
	const view: UsageLimitHandoffView = !credentialFailure
		? { kind: "none" }
		: episode?.result.kind === "failed"
			? { kind: "failed", error: episode.result.error, decision }
			: handled
				? { kind: "handled", ...(outcome ? { outcome } : {}) }
				: decision
					? { kind: "decided", decision }
					: { kind: "deciding" };
	if (recovery && !episode && recovery.stopped?.kind !== "superseded") {
		if (recovery.stopped || recovery.turnState === "failed") {
			return {
				view: {
					kind: "failed",
					decision,
					error: t(
						recovery.stopped?.kind === "exhausted"
							? "agents.recovery.exhausted"
							: "agents.recovery.failed",
					),
				},
				requestHandoff,
			};
		}
		return {
			view: {
				kind: "handled",
				...(recovery.target && recovery.turnState !== null
					? {
							outcome: {
								toName: recovery.target.name,
								resume:
									recovery.turnState === "accepted"
										? ("accepted" as const)
										: ("uncertain" as const),
							},
						}
					: {}),
			},
			requestHandoff,
		};
	}
	return { view, requestHandoff };
}
