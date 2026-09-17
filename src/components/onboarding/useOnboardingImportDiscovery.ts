import { useEffect, useRef, useState } from "react";
import type { OnboardingImportDraft } from "@/lib/onboarding/onboardingImportDraft";
import { readOnboardingImportJournal } from "@/lib/onboarding/onboardingImportJournal";
import { reconcileOnboardingImportDraft } from "@/lib/onboarding/onboardingImportReconcile";
import type { OnboardingImportScope } from "@/lib/onboarding/onboardingImportSelection";
import type { ProviderConversationDiscoverySource } from "@/lib/agents/providerConversationDiscovery";
import { discoverWorkspaceImportDraftProgressively } from "@/lib/workspace/workspaceImportControl";

export type OnboardingImportScanState =
	| { kind: "scanning"; sources: readonly ProviderConversationDiscoverySource[] }
	| { kind: "failed"; sources: readonly ProviderConversationDiscoverySource[] }
	| {
			kind: "ready";
			draft: OnboardingImportDraft;
			sources: readonly ProviderConversationDiscoverySource[];
			complete: boolean;
	  };

/** Own progressive scan races and the latest user-edited draft. The pure
 * reconciler decides authority; this hook only wires lifecycle and state. */
export function useOnboardingImportDiscovery(
	reload: number,
	scope: OnboardingImportScope,
) {
	const [scan, setScan] = useState<OnboardingImportScanState>({
		kind: "scanning",
		sources: [],
	});
	const [journalLocked, setJournalLocked] = useState(false);
	const draftRef = useRef<OnboardingImportDraft | undefined>(undefined);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;

	useEffect(() => {
		let disposed = false;
		const controller = new AbortController();
		const pending = readOnboardingImportJournal();
		if (pending?.status === "planned") {
			setJournalLocked(true);
			draftRef.current = pending.draft;
			setScan({
				kind: "ready",
				draft: pending.draft,
				sources: [],
				complete: true,
			});
			return () => {
				disposed = true;
				controller.abort();
			};
		}

		setJournalLocked(false);
		setScan(
			draftRef.current
				? {
						kind: "ready",
						draft: draftRef.current,
						sources: [],
						complete: false,
					}
				: { kind: "scanning", sources: [] },
		);
		void discoverWorkspaceImportDraftProgressively((update) => {
			if (disposed) return;
			const nextDraft = reconcileOnboardingImportDraft(
				draftRef.current,
				update.draft,
				update.authoritativeSourceKeys,
				scopeRef.current,
			);
			draftRef.current = nextDraft;
			const everySourceFailed =
				update.complete &&
				update.sources.length > 0 &&
				update.sources.every((source) => source.status === "failed");
			if (nextDraft.discoveredCount === 0 && everySourceFailed) {
				setScan({ kind: "failed", sources: update.sources });
			} else if (nextDraft.discoveredCount === 0 && !update.complete) {
				setScan({ kind: "scanning", sources: update.sources });
			} else {
				setScan({
					kind: "ready",
					draft: nextDraft,
					sources: update.sources,
					complete: update.complete,
				});
			}
		}, controller.signal).catch(() => {
			if (disposed) return;
			setScan(
				draftRef.current
					? {
							kind: "ready",
							draft: draftRef.current,
							sources: [],
							complete: true,
						}
					: { kind: "failed", sources: [] },
			);
		});
		return () => {
			disposed = true;
			controller.abort();
		};
	}, [reload]);

	return {
		scan,
		journalLocked,
		lockJournal: () => setJournalLocked(true),
		unlockJournal: () => setJournalLocked(false),
		updateDraft: (draft: OnboardingImportDraft) => {
			draftRef.current = draft;
			setScan((current) => ({
				kind: "ready",
				draft,
				sources: current.sources,
				complete: current.kind === "ready" ? current.complete : true,
			}));
		},
	};
}
