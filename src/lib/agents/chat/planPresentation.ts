/** Tolerant reader for provider plan payloads. The timeline's `plan` body is
 * opaque JSON by contract; this module recognizes the common list-of-steps
 * shapes (codex `turn/plan/updated` `{explanation, steps: [{step, status}]}`,
 * codex history plan items, todo-style `{todos: [{content, status}]}`) and
 * returns a checklist model. Anything unrecognized returns null and the UI
 * keeps the raw JSON disclosure — the parser never guesses. */
export type PlanStepState = "done" | "active" | "pending";

interface PlanStepPresentation {
	readonly text: string;
	readonly state: PlanStepState;
}

export interface PlanPresentation {
	readonly explanation: string | null;
	readonly steps: readonly PlanStepPresentation[];
}

const STEP_TEXT_FIELDS = ["step", "content", "text", "title"] as const;

const STEP_STATES: Readonly<Record<string, PlanStepState>> = {
	completed: "done",
	complete: "done",
	done: "done",
	in_progress: "active",
	inprogress: "active",
	active: "active",
	pending: "pending",
	todo: "pending",
};

function stepText(entry: Record<string, unknown>): string | null {
	for (const field of STEP_TEXT_FIELDS) {
		const value = entry[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function stepState(entry: Record<string, unknown>): PlanStepState {
	const status = entry.status;
	if (typeof status !== "string") return "pending";
	return STEP_STATES[status.toLowerCase().replace(/[\s-]/g, "_")] ?? "pending";
}

function presentSteps(value: unknown): readonly PlanStepPresentation[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const steps: PlanStepPresentation[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			if (!entry.trim()) return null;
			steps.push({ text: entry.trim(), state: "pending" });
			continue;
		}
		if (typeof entry !== "object" || entry === null) return null;
		const record = entry as Record<string, unknown>;
		const text = stepText(record);
		if (!text) return null;
		steps.push({ text, state: stepState(record) });
	}
	return steps;
}

export function presentPlan(value: unknown): PlanPresentation | null {
	const root =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	const steps = presentSteps(
		Array.isArray(value)
			? value
			: (root?.steps ?? root?.plan ?? root?.todos ?? null),
	);
	if (!steps) return null;
	const explanation = root?.explanation;
	return {
		explanation:
			typeof explanation === "string" && explanation.trim()
				? explanation.trim()
				: null,
		steps,
	};
}
