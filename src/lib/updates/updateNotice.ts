import { createBroadcast } from "@/lib/state/broadcast";

interface UpdateNoticeAction {
	label: string;
	progressLabel: string;
	disabled?: boolean;
	completion: "resolve" | "retain";
	run: () => void | Promise<void>;
}

export interface UpdateNotice {
	sourceRef: string;
	revision: string;
	title: string;
	description: string;
	impact: string;
	details?: string;
	/** Application releases surface ahead of optional tool maintenance. */
	importance?: "application" | "maintenance";
	progress?: { label: string; percent?: number };
	primaryAction: UpdateNoticeAction;
}

interface UpdateNoticeProjection extends UpdateNotice {
	dismissed: boolean;
	phase: "ready" | "running" | "failed";
	error?: string;
}

export interface UpdateNoticeSnapshot {
	notices: readonly UpdateNoticeProjection[];
	unresolvedCount: number;
}

interface StoredNotice {
	notice: UpdateNotice;
	dismissed: boolean;
	phase: UpdateNoticeProjection["phase"];
	error?: string;
}

type Listener = () => void;

const changed = createBroadcast<void>();
const records = new Map<string, StoredNotice>();
let snapshot: UpdateNoticeSnapshot = { notices: [], unresolvedCount: 0 };

function project(): UpdateNoticeSnapshot {
	const notices = [...records.values()].sort((a, b) => {
		const rank = (record: StoredNotice) =>
			(record.phase === "running" ? 2 : 0) +
			(record.notice.importance === "application" ? 1 : 0);
		return rank(b) - rank(a);
	}).map(
		(record): UpdateNoticeProjection => ({
			...record.notice,
			dismissed: record.dismissed,
			phase: record.phase,
			...(record.error ? { error: record.error } : {}),
		}),
	);
	return { notices, unresolvedCount: notices.length };
}

function publish(): void {
	snapshot = project();
	changed.publish();
}

export function updateNoticeSnapshot(): UpdateNoticeSnapshot {
	return snapshot;
}

export function subscribeUpdateNotices(listener: Listener): () => void {
	return changed.subscribe(listener);
}

/** Project one source-owned update without transferring install authority. */
export function upsertUpdateNotice(notice: UpdateNotice): void {
	const current = records.get(notice.sourceRef);
	records.set(notice.sourceRef, {
		notice,
		dismissed:
			current?.notice.revision === notice.revision ? current.dismissed : false,
		phase:
			current?.notice.revision === notice.revision ? current.phase : "ready",
		...(current?.notice.revision === notice.revision && current.error
			? { error: current.error }
			: {}),
	});
	publish();
}

export function clearUpdateNotice(sourceRef: string, revision?: string): void {
	const current = records.get(sourceRef);
	if (
		!current ||
		(revision !== undefined && current.notice.revision !== revision)
	) {
		return;
	}
	records.delete(sourceRef);
	publish();
}

export function dismissUpdateNotice(sourceRef: string): void {
	const current = records.get(sourceRef);
	if (!current || current.dismissed) return;
	records.set(sourceRef, { ...current, dismissed: true });
	publish();
}

/** Resurface unresolved records without changing their source-owned revision. */
export function resurfaceUpdateNotices(): void {
	let changed = false;
	for (const [sourceRef, current] of records) {
		if (!current.dismissed) continue;
		records.set(sourceRef, { ...current, dismissed: false });
		changed = true;
	}
	if (changed) publish();
}

/** Invoke the exact revision action and ignore late completion for a replacement. */
export async function performUpdateNoticeAction(
	sourceRef: string,
): Promise<void> {
	const selected = records.get(sourceRef);
	if (!selected || selected.phase === "running" || selected.notice.primaryAction.disabled) return;
	const revision = selected.notice.revision;
	records.set(sourceRef, { ...selected, phase: "running", error: undefined });
	publish();
	try {
		await selected.notice.primaryAction.run();
		const current = records.get(sourceRef);
		if (!current || current.notice.revision !== revision) return;
		if (selected.notice.primaryAction.completion === "resolve") {
			records.delete(sourceRef);
		} else {
			records.set(sourceRef, { ...current, phase: "ready", error: undefined });
		}
		publish();
	} catch (cause) {
		const current = records.get(sourceRef);
		if (!current || current.notice.revision !== revision) return;
		records.set(sourceRef, {
			...current,
			phase: "failed",
			error: cause instanceof Error ? cause.message : String(cause),
		});
		publish();
	}
}

export function resetUpdateNotices(): void {
	if (records.size === 0) return;
	records.clear();
	publish();
}
