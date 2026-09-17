import type { Provider } from "@/types";

export const RECENT_SESSION_HIDDEN_LIMIT = 512;

const IDENTITY_MEMBER_LIMIT = 4 * 1024;

export interface RecentSessionVisibilityTarget {
	readonly provider: Provider;
	readonly id: string;
	readonly mtime: number;
	readonly executionLocation: "local" | "ssh";
	readonly hostId?: string;
}

export interface HiddenRecentSession {
	readonly key: string;
	readonly observedMtime: number;
}

function validIdentityMember(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= IDENTITY_MEMBER_LIMIT
	);
}

function validMtime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function recentSessionVisibilityKey(
	target: RecentSessionVisibilityTarget,
): string | undefined {
	const provider = target.provider.trim();
	const id = target.id.trim();
	const host =
		target.executionLocation === "local" ? "local" : target.hostId?.trim();
	if (
		!validIdentityMember(provider) ||
		!validIdentityMember(id) ||
		!validIdentityMember(host)
	) {
		return undefined;
	}
	return JSON.stringify([target.executionLocation, host, provider, id]);
}

function validVisibilityKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length !== 4) return false;
		const [location, host, provider, id] = parsed;
		return (
			(location === "local" || location === "ssh") &&
			validIdentityMember(host) &&
			validIdentityMember(provider) &&
			validIdentityMember(id) &&
			(location === "ssh" || host === "local")
		);
	} catch {
		return false;
	}
}

function validHiddenRecentSession(
	value: unknown,
): value is HiddenRecentSession {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<HiddenRecentSession>;
	return validVisibilityKey(record.key) && validMtime(record.observedMtime);
}

export function normalizeHiddenRecentSessions(
	value: unknown,
): HiddenRecentSession[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const normalized: HiddenRecentSession[] = [];
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const record = value[index];
		if (!validHiddenRecentSession(record) || seen.has(record.key)) continue;
		seen.add(record.key);
		normalized.push(record);
		if (normalized.length === RECENT_SESSION_HIDDEN_LIMIT) break;
	}
	return normalized.reverse();
}

export function hideRecentSession(
	current: readonly HiddenRecentSession[],
	target: RecentSessionVisibilityTarget,
): readonly HiddenRecentSession[] {
	const key = recentSessionVisibilityKey(target);
	if (!key || !validMtime(target.mtime)) return current;
	const next = { key, observedMtime: target.mtime };
	return normalizeHiddenRecentSessions([
		...current.filter((record) => record.key !== key),
		next,
	]);
}

/** A removal suppresses only the exact observation the user saw. If the same
 * provider conversation receives newer activity, it becomes recent again. */
export function isRecentSessionHidden(
	target: RecentSessionVisibilityTarget,
	hidden: readonly HiddenRecentSession[],
): boolean {
	const key = recentSessionVisibilityKey(target);
	if (!key || !validMtime(target.mtime)) return false;
	const observation = hidden.find((record) => record.key === key);
	return Boolean(observation && target.mtime <= observation.observedMtime);
}
