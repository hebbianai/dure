type PaneActionValue = string | number | boolean | null;
export type PaneActionArguments = Readonly<Record<string, PaneActionValue>>;

export interface PaneActionRefusal {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly nextAction?: string;
}

interface PaneActionParameter {
	readonly type: "string" | "number" | "integer" | "boolean";
	readonly minimum?: number;
	readonly required?: boolean;
	readonly nullable?: boolean;
	readonly values?: readonly PaneActionValue[];
	readonly description?: string;
}

export interface PaneActionDefinition {
	readonly description: string;
	readonly error?: string;
	readonly parameters: Readonly<Record<string, PaneActionParameter>>;
	readonly unavailable?: PaneActionRefusal;
	readonly current?: PaneActionArguments;
}

/** A public, JSON-serializable observation from the action's owning domain.
 * Never put credentials, route capabilities or private runtime receipts here. */
export type PaneActionExecution =
	| {
			readonly outcome: "applied" | "unchanged" | "pending";
			readonly value?: unknown;
	  }
	| {
			readonly outcome: "refused" | "failed";
			readonly error: PaneActionRefusal;
	  };

export type PaneActionHandler = ((input?: unknown) => Promise<unknown>) & {
	readonly definition?: PaneActionDefinition;
};

export type DeclaredPaneAction = ((
	input?: unknown,
) => Promise<PaneActionExecution>) & {
	readonly definition: PaneActionDefinition;
};

function invalidArguments(message: string): PaneActionExecution {
	return {
		outcome: "refused",
		error: { code: "pane_action_arguments_invalid", message, retryable: false },
	};
}

/** The callable action is also its description. UI and external callers cross
 * the same argument/availability boundary before the domain handler runs. */
export function definePaneAction(
	definition: PaneActionDefinition,
	run: (input: PaneActionArguments) => Promise<PaneActionExecution>,
): DeclaredPaneAction {
	const parameterNames = Object.keys(definition.parameters);
	return Object.assign(
		async (input: unknown = {}): Promise<PaneActionExecution> => {
			if (definition.unavailable)
				return { outcome: "refused", error: definition.unavailable };
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				return invalidArguments("Action arguments must be an object.");
			}
			const values = input as Record<string, unknown>;
			if (Object.keys(values).some((key) => !parameterNames.includes(key))) {
				return invalidArguments(
					"Action arguments contain an unknown parameter.",
				);
			}
			for (const [key, parameter] of Object.entries(definition.parameters)) {
				const value = values[key];
				if (value === undefined && !parameter.required) continue;
				if (
					(value === null
						? !parameter.nullable
						: parameter.type === "integer"
							? !Number.isSafeInteger(value)
							: typeof value !== parameter.type) ||
					(typeof value === "string" && value.length > 4096) ||
					(typeof value === "number" && !Number.isFinite(value)) ||
					(typeof value === "number" &&
						parameter.minimum !== undefined &&
						value < parameter.minimum) ||
					(parameter.values &&
						!parameter.values.includes(value as PaneActionValue))
				)
					return invalidArguments(`Invalid value for ${key}.`);
			}
			return run(values as PaneActionArguments);
		},
		{ definition },
	);
}
