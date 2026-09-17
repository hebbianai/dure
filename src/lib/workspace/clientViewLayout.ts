import { validClientViewToken } from "@/lib/ipc/clientViewToken";
import type { ClientViewLayoutSlotV1 } from "@/lib/workspace/clientViewState";
import { sessionIdForPane } from "@/lib/workspace/layout/paneSessionReference";
import {
	normalizePersistedPaneDefinition,
	paneContentComponent,
} from "@/lib/workspace/layout/persistedPaneLayout";
import type { Agent } from "@/types";

// Re-exported so layout consumers keep one import site for the shared
// client-view token contract.
export { validClientViewToken };

type UnknownRecord = Record<string, unknown>;

interface LayoutLeaf {
	node: UnknownRecord;
	group: UnknownRecord;
	groupId: string;
	views: string[];
	basisPoints: number;
}

export interface ClientViewLayoutApplyResult {
	status: "applied" | "unchanged" | "topology_mismatch";
	layout: unknown;
}

function record(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function positive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

function cloneJson(value: unknown): unknown | null {
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return null;
	}
}

function childSizes(children: readonly UnknownRecord[]): number[] {
	const sizes = children.map((child) => positive(child.size) ?? 0);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	return total > 0 ? sizes : children.map(() => 1);
}

function collectLeaves(root: UnknownRecord): LayoutLeaf[] | null {
	const leaves: LayoutLeaf[] = [];
	const visit = (node: UnknownRecord, basisPoints: number): boolean => {
		if (node.type === "leaf") {
			const group = record(node.data);
			if (
				!group ||
				!validClientViewToken(group.id) ||
				!Array.isArray(group.views)
			) {
				return false;
			}
			const views = group.views.filter((view): view is string =>
				validClientViewToken(view),
			);
			if (views.length !== group.views.length || views.length === 0)
				return false;
			leaves.push({ node, group, groupId: group.id, views, basisPoints });
			return true;
		}
		if (node.type !== "branch" || !Array.isArray(node.data)) return false;
		const children = node.data.map(record);
		if (children.some((child) => !child)) return false;
		const validChildren = children as UnknownRecord[];
		if (validChildren.length === 0) return true;
		const sizes = childSizes(validChildren);
		const total = sizes.reduce((sum, size) => sum + size, 0);
		return validChildren.every((child, index) =>
			visit(child, (basisPoints * sizes[index]) / total),
		);
	};
	return visit(root, 10_000) ? leaves : null;
}

function layoutLeaves(layout: unknown): LayoutLeaf[] | null {
	const root = record(record(record(layout)?.grid)?.root);
	return root ? collectLeaves(root) : null;
}

export function projectClientViewLayout(
	layout: unknown,
): ClientViewLayoutSlotV1[] {
	const leaves = layoutLeaves(layout);
	if (!leaves) return [];
	const slots: ClientViewLayoutSlotV1[] = [];
	const groups = new Set<string>();
	const panes = new Set<string>();
	for (const leaf of leaves) {
		if (groups.has(leaf.groupId)) return [];
		groups.add(leaf.groupId);
		const sizeBasisPoints = Math.max(
			1,
			Math.min(10_000, Math.round(leaf.basisPoints)),
		);
		for (const [order, paneId] of leaf.views.entries()) {
			if (slots.length === 128 || panes.has(paneId)) return [];
			panes.add(paneId);
			slots.push({ paneId, groupId: leaf.groupId, order, sizeBasisPoints });
		}
	}
	return slots;
}

function validSlots(
	slots: readonly ClientViewLayoutSlotV1[],
): Map<string, ClientViewLayoutSlotV1[]> | null {
	if (slots.length === 0 || slots.length > 128) return null;
	const byGroup = new Map<string, ClientViewLayoutSlotV1[]>();
	const panes = new Set<string>();
	for (const slot of slots) {
		if (
			!validClientViewToken(slot.paneId) ||
			!validClientViewToken(slot.groupId) ||
			!Number.isSafeInteger(slot.order) ||
			slot.order < 0 ||
			!Number.isSafeInteger(slot.sizeBasisPoints) ||
			slot.sizeBasisPoints < 1 ||
			slot.sizeBasisPoints > 10_000 ||
			panes.has(slot.paneId)
		) {
			return null;
		}
		panes.add(slot.paneId);
		const group = byGroup.get(slot.groupId) ?? [];
		if (group.some((entry) => entry.order === slot.order)) return null;
		group.push(slot);
		byGroup.set(slot.groupId, group);
	}
	return byGroup;
}

function leafBasis(
	leaf: LayoutLeaf,
	slots: readonly ClientViewLayoutSlotV1[],
): number | null {
	if (slots.length !== leaf.views.length) return null;
	const local = new Set(leaf.views);
	if (slots.some((slot) => !local.has(slot.paneId))) return null;
	const sizes = new Set(slots.map((slot) => slot.sizeBasisPoints));
	return sizes.size === 1 ? (slots[0]?.sizeBasisPoints ?? null) : null;
}

function descendantBasis(
	node: UnknownRecord,
	bases: ReadonlyMap<string, number>,
): number {
	if (node.type === "leaf") {
		const group = record(node.data);
		return typeof group?.id === "string" ? (bases.get(group.id) ?? 0) : 0;
	}
	if (node.type !== "branch" || !Array.isArray(node.data)) return 0;
	return node.data.reduce((sum, child) => {
		const candidate = record(child);
		return sum + (candidate ? descendantBasis(candidate, bases) : 0);
	}, 0);
}

function applySizes(
	node: UnknownRecord,
	bases: ReadonlyMap<string, number>,
): void {
	if (node.type !== "branch" || !Array.isArray(node.data)) return;
	const children = node.data.map(record).filter(Boolean) as UnknownRecord[];
	const totalSize = childSizes(children).reduce((sum, size) => sum + size, 0);
	const weights = children.map((child) => descendantBasis(child, bases));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	if (totalWeight > 0) {
		children.forEach((child, index) => {
			child.size = Math.max(
				1,
				Math.round((totalSize * weights[index]) / totalWeight),
			);
		});
	}
	children.forEach((child) => {
		applySizes(child, bases);
	});
}

/**
 * Apply only geometry/order onto an exact existing pane/group topology. Remote
 * presentation state can never create, remove, or retarget a runtime pane.
 */
export function applyClientViewLayout(
	layout: unknown,
	slots: readonly ClientViewLayoutSlotV1[],
): ClientViewLayoutApplyResult {
	const byGroup = validSlots(slots);
	const cloned = cloneJson(layout);
	const leaves = cloned ? layoutLeaves(cloned) : null;
	if (!byGroup || !leaves || byGroup.size !== leaves.length) {
		return { status: "topology_mismatch", layout };
	}
	const bases = new Map<string, number>();
	for (const leaf of leaves) {
		const remote = byGroup.get(leaf.groupId);
		const basis = remote ? leafBasis(leaf, remote) : null;
		if (!remote || basis === null) {
			return { status: "topology_mismatch", layout };
		}
		const sorted = [...remote].sort((left, right) => left.order - right.order);
		if (sorted.some((slot, index) => slot.order !== index)) {
			return { status: "topology_mismatch", layout };
		}
		const ordered = sorted.map((slot) => slot.paneId);
		leaf.group.views = ordered;
		if (
			typeof leaf.group.activeView !== "string" ||
			!ordered.includes(leaf.group.activeView)
		) {
			leaf.group.activeView = ordered[0];
		}
		bases.set(leaf.groupId, basis);
	}
	const root = record(record(record(cloned)?.grid)?.root);
	if (!root) return { status: "topology_mismatch", layout };
	applySizes(root, bases);
	return {
		status:
			JSON.stringify(cloned) === JSON.stringify(layout)
				? "unchanged"
				: "applied",
		layout: cloned,
	};
}

export function selectedPaneFromLayout(layout: unknown): string | null {
	const candidate = record(layout);
	const activeGroup = candidate?.activeGroup;
	if (typeof activeGroup !== "string") return null;
	const leaf = layoutLeaves(layout)?.find(
		(entry) => entry.groupId === activeGroup,
	);
	const activeView = leaf?.group.activeView;
	return typeof activeView === "string" && leaf?.views.includes(activeView)
		? activeView
		: (leaf?.views[0] ?? null);
}

export function sessionIdForClientViewPane(
	layout: unknown,
	paneId: string | null,
	agents: readonly Pick<
		Agent,
		"id" | "interactionProfile" | "runtimeBinding" | "sessionId"
	>[] = [],
): string | null {
	if (!paneId) return null;
	const panels = record(record(layout)?.panels);
	const panel = record(normalizePersistedPaneDefinition(paneId, panels?.[paneId]));
	const params = record(panel?.params);
	const sessionId = sessionIdForPane(
		{
			id: paneId,
			component: paneContentComponent(panel),
			params: params ?? {},
		},
		agents,
	);
	return validClientViewToken(sessionId) ? sessionId : null;
}
