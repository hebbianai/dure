const ANIMATION_CATEGORIES = [
	"chat-shimmer",
	"other",
	"pulse",
	"spin",
	"terminal-cursor",
] as const;
const ANIMATION_PLAY_STATES = ["paused", "running"] as const;
const ANIMATION_SCOPES = [
	"active-tabpanel",
	"hidden-tabpanel",
	"unscoped",
] as const;
const DOCUMENT_VISIBILITIES = ["hidden", "unknown", "visible"] as const;

type WindowAnimationCategory = (typeof ANIMATION_CATEGORIES)[number];
type WindowAnimationPlayState = (typeof ANIMATION_PLAY_STATES)[number];
type WindowAnimationScope = (typeof ANIMATION_SCOPES)[number];

const CATEGORY_BY_ANIMATION_NAME = new Map<string, WindowAnimationCategory>([
	["chat-shimmer-sweep", "chat-shimmer"],
	["pulse", "pulse"],
	["spin", "spin"],
	["terminal-viewport-blink", "terminal-cursor"],
]);
const TABPANEL_SELECTOR = '[role="tabpanel"]';
const HIDDEN_TABPANEL_SELECTOR = `${TABPANEL_SELECTOR}[aria-hidden="true"]`;
const MAX_GROUPS =
	ANIMATION_CATEGORIES.length *
	ANIMATION_PLAY_STATES.length *
	ANIMATION_SCOPES.length;
const TEXT_ENTRY_INPUT_TYPES = new Set([
	"email",
	"number",
	"password",
	"search",
	"tel",
	"text",
	"url",
]);

interface WindowAnimationGroup {
	category: WindowAnimationCategory;
	playState: WindowAnimationPlayState;
	scope: WindowAnimationScope;
	count: number;
	minDurationMs: number | null;
	maxDurationMs: number | null;
}

export interface WindowAnimationDiagnostics {
	supported: boolean;
	documentVisibility: (typeof DOCUMENT_VISIBILITIES)[number];
	focusedEditable: boolean;
	groups: WindowAnimationGroup[];
}

type AnimationContext = Pick<
	WindowAnimationDiagnostics,
	"documentVisibility" | "focusedEditable"
>;
type AnimationContextDocument = Pick<
	Document,
	"activeElement" | "hasFocus" | "visibilityState"
>;
type AnimationDocument = AnimationContextDocument &
	Pick<Document, "getAnimations">;

function hasLiteral<const Values extends readonly string[]>(
	values: Values,
	value: unknown,
): value is Values[number] {
	return (
		typeof value === "string" && (values as readonly string[]).includes(value)
	);
}

function isFocusedEditable(activeElement: Element | null): boolean {
	if (activeElement instanceof HTMLTextAreaElement) {
		return !activeElement.disabled && !activeElement.readOnly;
	}
	if (activeElement instanceof HTMLInputElement) {
		return (
			TEXT_ENTRY_INPUT_TYPES.has(activeElement.type) &&
			!activeElement.disabled &&
			!activeElement.readOnly
		);
	}
	return (
		activeElement instanceof HTMLElement &&
		activeElement.isContentEditable === true
	);
}

function documentContext(
	animationDocument?: AnimationContextDocument,
): AnimationContext {
	if (!animationDocument) {
		return { documentVisibility: "unknown", focusedEditable: false };
	}
	return {
		documentVisibility: hasLiteral(
			DOCUMENT_VISIBILITIES,
			animationDocument.visibilityState,
		)
			? animationDocument.visibilityState
			: "unknown",
		focusedEditable:
			animationDocument.hasFocus() &&
			isFocusedEditable(animationDocument.activeElement),
	};
}

function unavailable(
	animationDocument?: AnimationContextDocument,
): WindowAnimationDiagnostics {
	return {
		...documentContext(animationDocument),
		groups: [],
		supported: false,
	};
}

export function unavailableWindowAnimationDiagnostics(): WindowAnimationDiagnostics {
	return unavailable();
}

function animationScope(animation: Animation): WindowAnimationScope {
	const target = (
		animation.effect as (AnimationEffect & { target?: unknown }) | null
	)?.target;
	if (!(target instanceof Element)) return "unscoped";
	if (target.closest(HIDDEN_TABPANEL_SELECTOR)) return "hidden-tabpanel";
	return target.closest(TABPANEL_SELECTOR) ? "active-tabpanel" : "unscoped";
}

function finiteDuration(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function groupKey(group: {
	category: WindowAnimationCategory;
	playState: WindowAnimationPlayState;
	scope: WindowAnimationScope;
}): string {
	return `${group.category}\u0000${group.scope}\u0000${group.playState}`;
}

function compareGroups(
	left: WindowAnimationGroup,
	right: WindowAnimationGroup,
): number {
	const leftKey = groupKey(left);
	const rightKey = groupKey(right);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

// Keep this on the explicit report path: getAnimations() may apply pending
// animation style changes before returning.
export function readWindowAnimationDiagnostics(
	animationDocument: AnimationDocument = document,
): WindowAnimationDiagnostics {
	const getAnimations = animationDocument.getAnimations;
	if (typeof getAnimations !== "function")
		return unavailable(animationDocument);

	try {
		const groups = new Map<string, WindowAnimationGroup>();
		for (const animation of getAnimations.call(animationDocument)) {
			const timing = animation.effect?.getTiming();
			if (
				!hasLiteral(ANIMATION_PLAY_STATES, animation.playState) ||
				timing?.iterations !== Infinity
			) {
				continue;
			}
			const animationName = (
				animation as Animation & { animationName?: unknown }
			).animationName;
			const identity = {
				category:
					(typeof animationName === "string"
						? CATEGORY_BY_ANIMATION_NAME.get(animationName)
						: undefined) ?? "other",
				playState: animation.playState,
				scope: animationScope(animation),
			};
			const key = groupKey(identity);
			const durationMs = finiteDuration(timing.duration);
			const current = groups.get(key);
			if (!current) {
				groups.set(key, {
					...identity,
					count: 1,
					maxDurationMs: durationMs,
					minDurationMs: durationMs,
				});
				continue;
			}
			current.count += 1;
			if (durationMs !== null) {
				current.minDurationMs =
					current.minDurationMs === null
						? durationMs
						: Math.min(current.minDurationMs, durationMs);
				current.maxDurationMs =
					current.maxDurationMs === null
						? durationMs
						: Math.max(current.maxDurationMs, durationMs);
			}
		}
		return {
			...documentContext(animationDocument),
			groups: [...groups.values()].sort(compareGroups),
			supported: true,
		};
	} catch {
		return unavailable(animationDocument);
	}
}

function parseGroup(value: unknown): WindowAnimationGroup | undefined {
	if (!value || typeof value !== "object") return undefined;
	const group = value as Record<string, unknown>;
	const minDurationMs = finiteDuration(group.minDurationMs);
	const maxDurationMs = finiteDuration(group.maxDurationMs);
	const validNullRange =
		group.minDurationMs === null && group.maxDurationMs === null;
	const validFiniteRange =
		minDurationMs !== null &&
		maxDurationMs !== null &&
		minDurationMs <= maxDurationMs;
	if (
		!hasLiteral(ANIMATION_CATEGORIES, group.category) ||
		!hasLiteral(ANIMATION_PLAY_STATES, group.playState) ||
		!hasLiteral(ANIMATION_SCOPES, group.scope) ||
		typeof group.count !== "number" ||
		!Number.isSafeInteger(group.count) ||
		group.count <= 0 ||
		(!validNullRange && !validFiniteRange)
	) {
		return undefined;
	}
	return {
		category: group.category,
		count: group.count,
		maxDurationMs,
		minDurationMs,
		playState: group.playState,
		scope: group.scope,
	};
}

export function parseWindowAnimationDiagnostics(
	value: unknown,
): WindowAnimationDiagnostics | undefined {
	if (!value || typeof value !== "object") return undefined;
	const diagnostics = value as Record<string, unknown>;
	if (
		typeof diagnostics.supported !== "boolean" ||
		!hasLiteral(DOCUMENT_VISIBILITIES, diagnostics.documentVisibility) ||
		typeof diagnostics.focusedEditable !== "boolean" ||
		!Array.isArray(diagnostics.groups) ||
		diagnostics.groups.length > MAX_GROUPS
	) {
		return undefined;
	}

	const groups: WindowAnimationGroup[] = [];
	const keys = new Set<string>();
	for (const value of diagnostics.groups) {
		const group = parseGroup(value);
		if (!group) return undefined;
		const key = groupKey(group);
		if (keys.has(key)) return undefined;
		keys.add(key);
		groups.push(group);
	}
	if (!diagnostics.supported && groups.length > 0) return undefined;
	return {
		documentVisibility: diagnostics.documentVisibility,
		focusedEditable: diagnostics.focusedEditable,
		groups: groups.sort(compareGroups),
		supported: diagnostics.supported,
	};
}
