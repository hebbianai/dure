import { applyOnboardingImportDraft } from "@/lib/onboarding/onboardingImportApply";
import {
	buildOnboardingImportDraft,
	onboardingImportCounts,
	type OnboardingImportDraft,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	readOnboardingImportJournal,
	type OnboardingImportReceiptV1,
} from "@/lib/onboarding/onboardingImportJournal";
import {
	discoverProviderConversationsProgressively,
	listProviderConversations,
	type ProviderConversationDiscoverySource,
	type ProviderConversationRecord,
} from "@/lib/agents/providerConversationDiscovery";
import { projectRecentWork } from "@/lib/sessions/recentWork";
import { useStore } from "@/store";

const IMPORT_SCAN_LIMIT = 600;
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_PLANS = 8;
const PLAN_TOKEN = /^wip_[a-f0-9]{32}$/;

interface CachedPlan {
	draft: OnboardingImportDraft;
	createdAtMs: number;
	expiresAtMs: number;
}

export interface WorkspaceImportPreviewV1 {
	schemaVersion: 1;
	planToken: string;
	createdAtMs: number;
	expiresAtMs: number;
	desktopCount: number;
	paneCount: number;
	draft: OnboardingImportDraft;
}

const cachedPlans = new Map<string, CachedPlan>();

function planToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `wip_${[...bytes]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}

function prunePlans(nowMs: number): void {
	for (const [token, plan] of cachedPlans) {
		if (plan.expiresAtMs <= nowMs) cachedPlans.delete(token);
	}
	while (cachedPlans.size >= MAX_CACHED_PLANS) {
		const oldest = cachedPlans.keys().next().value;
		if (typeof oldest !== "string") break;
		cachedPlans.delete(oldest);
	}
}

export function defaultWorkspaceImportDraft(
	entries: readonly ProviderConversationRecord[],
): OnboardingImportDraft {
	return buildOnboardingImportDraft(
		projectRecentWork({
			entries,
			agents: [],
			projects: [],
			activity: {},
			limit: IMPORT_SCAN_LIMIT,
		}),
	);
}

async function discoverWorkspaceImportDraft(): Promise<OnboardingImportDraft> {
	return defaultWorkspaceImportDraft(
		await listProviderConversations(useStore.getState().sshHosts),
	);
}

export interface WorkspaceImportDiscoveryUpdate {
	draft: OnboardingImportDraft;
	sources: readonly ProviderConversationDiscoverySource[];
	authoritativeSourceKeys: readonly string[];
	complete: boolean;
}

/** Project progressive provider discovery into onboarding drafts while keeping
 * source authority explicit for the presentation-layer reconciliation step. */
export async function discoverWorkspaceImportDraftProgressively(
	onUpdate: (update: WorkspaceImportDiscoveryUpdate) => void,
	signal?: AbortSignal,
): Promise<WorkspaceImportDiscoveryUpdate> {
	let latest: WorkspaceImportDiscoveryUpdate | undefined;
	await discoverProviderConversationsProgressively(
		useStore.getState().sshHosts,
		(snapshot) => {
			latest = {
				draft: defaultWorkspaceImportDraft(snapshot.records),
				sources: snapshot.sources,
				authoritativeSourceKeys: snapshot.sources
					.filter((source) => source.status === "succeeded")
					.map((source) => source.key),
				complete: snapshot.complete,
			};
			onUpdate(latest);
		},
		signal,
	);
	if (!latest) {
		throw new Error("workspace import discovery completed without a snapshot");
	}
	return latest;
}

export async function createWorkspaceImportPreview(
	nowMs = Date.now(),
): Promise<WorkspaceImportPreviewV1> {
	const draft = await discoverWorkspaceImportDraft();
	prunePlans(nowMs);
	const token = planToken();
	const plan: CachedPlan = {
		draft,
		createdAtMs: nowMs,
		expiresAtMs: nowMs + PLAN_TTL_MS,
	};
	cachedPlans.set(token, plan);
	const counts = onboardingImportCounts(draft);
	return {
		schemaVersion: 1,
		planToken: token,
		createdAtMs: plan.createdAtMs,
		expiresAtMs: plan.expiresAtMs,
		desktopCount: counts.desktopCount,
		paneCount: counts.paneCount,
		draft,
	};
}

export function workspaceImportStatus(nowMs = Date.now()) {
	prunePlans(nowMs);
	const journal = readOnboardingImportJournal();
	return {
		schemaVersion: 1 as const,
		journalStatus: journal?.status ?? "missing",
		activePlanCount: cachedPlans.size,
		...(journal?.receipt ? { receipt: journal.receipt } : {}),
	};
}

export async function applyWorkspaceImportPlan(
	token: string,
	nowMs = Date.now(),
): Promise<OnboardingImportReceiptV1> {
	if (!PLAN_TOKEN.test(token)) throw new Error("workspace import plan token is invalid");
	prunePlans(nowMs);
	const plan = cachedPlans.get(token);
	if (!plan) throw new Error("workspace import plan is missing or expired; preview again");
	const receipt = await applyOnboardingImportDraft(plan.draft);
	cachedPlans.delete(token);
	return receipt;
}

export function clearWorkspaceImportPlansForTest(): void {
	cachedPlans.clear();
}
