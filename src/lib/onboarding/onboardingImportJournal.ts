import { nanoid } from "nanoid";
import type { OnboardingImportDraft } from "@/lib/onboarding/onboardingImportDraft";
import { validClientViewToken } from "@/lib/ipc/clientViewToken";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

const JOURNAL_KEY = "dure:first-run-session-import:v1";
const SAFE_ID = /^[A-Za-z0-9_-]{6,96}$/;
// v1 journals created before the default changed from 10 to 8 remain recovery
// authority after apply starts. New drafts enforce the current limit upstream.
export const MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES = 10;

export interface OnboardingImportReceiptV1 {
	projectIds: readonly string[];
	desktopIds: readonly string[];
	agentIds: readonly string[];
	committedAtMs: number;
}

export interface OnboardingImportJournalV1 {
	schemaVersion: 1;
	applyId: string;
	status: "planned" | "complete";
	createdAtMs: number;
	draft: OnboardingImportDraft;
	desktopIds: readonly string[];
	agentIds: readonly string[];
	paneIds: readonly string[];
	receipt?: OnboardingImportReceiptV1;
}

export interface OnboardingImportJournalStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function browserStorage(): OnboardingImportJournalStorage | undefined {
	return typeof localStorage === "undefined" ? undefined : localStorage;
}

function stringField(value: unknown, maximum = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validDraft(value: unknown): value is OnboardingImportDraft {
	if (!value || typeof value !== "object") return false;
	const draft = value as Record<string, unknown>;
	if (!Array.isArray(draft.desktops) || draft.desktops.length > 100) return false;
	let paneCount = 0;
	for (const rawDesktop of draft.desktops) {
		if (!rawDesktop || typeof rawDesktop !== "object") return false;
		const desktop = rawDesktop as Record<string, unknown>;
		if (
			!stringField(desktop.id, 256) ||
			!stringField(desktop.sourceGroupIdentity) ||
			(desktop.sourceGroupName !== undefined &&
				!stringField(desktop.sourceGroupName, 256)) ||
			!stringField(desktop.name, 256) ||
			typeof desktop.included !== "boolean" ||
			!Array.isArray(desktop.panes) ||
			desktop.panes.length > MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES
		) {
			return false;
		}
		paneCount += desktop.panes.length;
		for (const rawPane of desktop.panes) {
			if (!rawPane || typeof rawPane !== "object") return false;
			const pane = rawPane as Record<string, unknown>;
			if (
				!stringField(pane.key, 1024) ||
				!stringField(pane.conversationId, 256) ||
				!stringField(pane.title, 256) ||
				!stringField(pane.cwd) ||
				!stringField(pane.workspaceRoot) ||
				!stringField(pane.groupIdentity) ||
				typeof pane.mtime !== "number" ||
				typeof pane.defaultSelected !== "boolean" ||
				(pane.recencyBucket !== undefined &&
					pane.recencyBucket !== "recent" &&
					pane.recencyBucket !== "older") ||
				typeof pane.selected !== "boolean" ||
				!stringField(pane.provider, 32) ||
				(pane.executionLocation !== "local" &&
					pane.executionLocation !== "ssh") ||
				(pane.hostId !== undefined && !stringField(pane.hostId, 256))
			) {
				return false;
			}
			if (
				(pane.repositoryCommonDir !== undefined &&
					!stringField(pane.repositoryCommonDir)) ||
				(pane.repositoryRemoteIdentity !== undefined &&
					!stringField(pane.repositoryRemoteIdentity))
			) {
				return false;
			}
		}
	}
	return paneCount <= 600 && typeof draft.discoveredCount === "number";
}

function validStringIds(value: unknown, expectedLength: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length === expectedLength &&
		value.every((entry) => stringField(entry, 128) && SAFE_ID.test(entry))
	);
}

function parseJournal(raw: string): OnboardingImportJournalV1 | undefined {
	try {
		if (!raw || raw.length > 2 * 1024 * 1024) return undefined;
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			value.schemaVersion !== 1 ||
			!stringField(value.applyId, 96) ||
			!SAFE_ID.test(value.applyId) ||
			(value.status !== "planned" && value.status !== "complete") ||
			typeof value.createdAtMs !== "number" ||
			!validDraft(value.draft)
		) {
			return undefined;
		}
		const draft = value.draft;
		const selectedDesktopCount = draft.desktops.filter(
			(desktop) => desktop.included && desktop.panes.some((pane) => pane.selected),
		).length;
		const selectedPaneCount = draft.desktops.reduce(
			(total, desktop) =>
				total +
				(desktop.included
					? desktop.panes.filter((pane) => pane.selected).length
					: 0),
			0,
		);
		if (
			!validStringIds(value.desktopIds, selectedDesktopCount) ||
			!validStringIds(value.agentIds, selectedPaneCount)
		) {
			return undefined;
		}
		// Older journals issued Agent-shaped views. Preserve those exact IDs only
		// at this recovery boundary; an explicit invalid plan is never replaced.
		const paneIds = Object.getOwnPropertyDescriptor(value, "paneIds")
			? value.paneIds
			: value.agentIds.map((id) => `agent:${id}`);
		if (
			!Array.isArray(paneIds) ||
			paneIds.length !== selectedPaneCount ||
			!paneIds.every(validClientViewToken) ||
			new Set(paneIds).size !== paneIds.length
		)
			return undefined;
		return { ...value, paneIds } as unknown as OnboardingImportJournalV1;
	} catch {
		return undefined;
	}
}

export function readOnboardingImportJournal(
	storage = browserStorage(),
): OnboardingImportJournalV1 | undefined {
	try {
		const raw = storage?.getItem(JOURNAL_KEY);
		return raw ? parseJournal(raw) : undefined;
	} catch {
		return undefined;
	}
}

export function beginOnboardingImportJournal(
	draft: OnboardingImportDraft,
	options: { reusableDesktopId?: string } = {},
	storage = browserStorage(),
): OnboardingImportJournalV1 {
	if (!storage) throw new Error("onboarding import journal storage unavailable");
	const raw = storage.getItem(JOURNAL_KEY);
	if (raw !== null) {
		const previous = parseJournal(raw);
		if (!previous) throw new Error("onboarding import journal is invalid");
		return previous;
	}
	const applyId = nanoid(16);
	const selectedDesktops = draft.desktops.filter(
		(desktop) => desktop.included && desktop.panes.some((pane) => pane.selected),
	);
	const paneCount = selectedDesktops.reduce(
		(total, desktop) => total + desktop.panes.filter((pane) => pane.selected).length,
		0,
	);
	const desktopIds = selectedDesktops.map((_, index) =>
		index === 0 && options.reusableDesktopId
			? options.reusableDesktopId
			: `desk-import-${applyId}-${index + 1}`,
	);
	const journal: OnboardingImportJournalV1 = {
		schemaVersion: 1,
		applyId,
		status: "planned",
		createdAtMs: Date.now(),
		draft,
		desktopIds,
		agentIds: Array.from(
			{ length: paneCount },
			(_, index) => `agent-import-${applyId}-${index + 1}`,
		),
		paneIds: Array.from({ length: paneCount }, () => createPaneId()),
	};
	storage.setItem(JOURNAL_KEY, JSON.stringify(journal));
	return journal;
}

export function completeOnboardingImportJournal(
	journal: OnboardingImportJournalV1,
	receipt: OnboardingImportReceiptV1,
	storage = browserStorage(),
): OnboardingImportJournalV1 {
	if (!storage) throw new Error("onboarding import journal storage unavailable");
	const complete: OnboardingImportJournalV1 = {
		...journal,
		status: "complete",
		receipt,
	};
	storage.setItem(JOURNAL_KEY, JSON.stringify(complete));
	return complete;
}

export function hasPendingOnboardingImportJournal(): boolean {
	return readOnboardingImportJournal()?.status === "planned";
}

/** 실패한 적용을 사용자가 명시적으로 포기한다 — 저널을 지워 잠금을 풀고
 *  처음부터 다시 검색할 수 있게 한다. 적용이 부분 실행됐다면 이미 만들어진
 *  리소스는 남는다(일반 경로로 정리 가능). 이 탈출구가 없으면 첫 실행 화면이
 *  영구 잠금된다(2026-08-01 UX 검수). 호출 전 반드시 사용자 확인을 거칠 것. */
export function discardOnboardingImportJournal(storage = browserStorage()): void {
	storage?.removeItem(JOURNAL_KEY);
}
