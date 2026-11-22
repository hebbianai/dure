import {
	type DureAgentRuntimeLaunchSelectionV1,
	type DureProviderPermissionModeV1,
	isProviderPermissionMode,
} from "@/lib/ipc/dureAgentRuntime";
import { isRecord, nonEmptyString } from "@/lib/payloadGuards";
import type { AgentRuntimeLaunchSelectionView } from "./agentRuntimeLaunchSelection";
import type { agentRuntimeSettingActions } from "./agentRuntimeSettingActions";

/** One menu entry of a launch pill. */
interface AgentLaunchSelectionOptionV1 {
	readonly value: string;
	readonly label: string;
	readonly tone?: "danger";
}

/** Everything the launch pills (model, effort, permissions) present, computed
 * once by the surface that owns the Agent's launch selection. It is plain
 * JSON: an Agent's large window renders the copy its source pane sends, so
 * both surfaces show the same selection, menus and failures (#624). */
export interface AgentLaunchSelectionPresentationV1 {
	readonly loaded: boolean;
	readonly hydrationError: boolean;
	readonly model: string | null;
	readonly effort: string | null;
	readonly permissionMode: DureProviderPermissionModeV1;
	readonly switching: boolean;
	/** Failure detail, shown as the error's title. */
	readonly error: string | null;
	readonly errorMessage?: string;
	readonly pending?: {
		readonly requestId: string;
		readonly selection: DureAgentRuntimeLaunchSelectionV1;
		readonly error?: string;
	};
	readonly observedModel: string | null;
	/** The provider catalog behind the model and effort menus. `offered`: it
	 * loads on demand when a menu opens. */
	readonly catalog: {
		readonly offered: boolean;
		readonly status: "idle" | "loading" | "failed";
	};
	readonly modelOptions: readonly AgentLaunchSelectionOptionV1[];
	readonly effortOptions: readonly AgentLaunchSelectionOptionV1[];
	readonly permissionOptions: readonly AgentLaunchSelectionOptionV1[];
}

const SELECTION_FIELDS = ["model", "effort", "permissionMode"] as const;
type AgentLaunchSelectionField = (typeof SELECTION_FIELDS)[number];
const PLAIN_COMMANDS = [
	"apply_pending",
	"cancel_pending",
	"load_catalog",
	"retry_hydration",
	"dismiss_error",
] as const;

/** What a launch pill asks for. Plain data, so a surface that does not own
 * the launch selection can send it to the one that does. */
export type AgentLaunchSelectionCommand =
	| {
			readonly kind: "select";
			readonly field: AgentLaunchSelectionField;
			readonly value: string | null;
	  }
	| { readonly kind: (typeof PLAIN_COMMANDS)[number] };

/** A launch-pill surface: what it presents and where its commands run. */
export interface AgentLaunchSelectionSurface {
	readonly presentation: AgentLaunchSelectionPresentationV1;
	/** Settles once the command ran; a failure shows in the presentation. */
	run(command: AgentLaunchSelectionCommand): Promise<void>;
}

type AgentRuntimeSettings = ReturnType<typeof agentRuntimeSettingActions>;

/** The presentation of the launch selection this surface owns. */
export function agentLaunchSelectionPresentation({
	launch,
	settings,
	observedModel,
	catalog,
}: {
	launch: AgentRuntimeLaunchSelectionView;
	settings: AgentRuntimeSettings;
	observedModel: string | null;
	catalog: AgentLaunchSelectionPresentationV1["catalog"];
}): AgentLaunchSelectionPresentationV1 {
	const option = ({
		value,
		label,
		tone,
	}: {
		value: string;
		label: string;
		tone?: "danger";
	}): AgentLaunchSelectionOptionV1 => ({
		value,
		label,
		...(tone ? { tone } : {}),
	});
	return {
		loaded: launch.loaded,
		hydrationError: launch.hydrationError,
		model: launch.model,
		effort: launch.effort,
		permissionMode: launch.permissionMode,
		switching: launch.switching,
		error: launch.error,
		...(launch.errorMessage !== undefined
			? { errorMessage: launch.errorMessage }
			: {}),
		...(launch.pending
			? {
					pending: {
						requestId: launch.pending.requestId,
						selection: {
							model: launch.pending.selection.model,
							effort: launch.pending.selection.effort,
							permissionMode: launch.pending.selection.permissionMode,
						},
						...(launch.pending.error !== undefined
							? { error: launch.pending.error }
							: {}),
					},
				}
			: {}),
		observedModel,
		catalog,
		modelOptions: settings.modelOptions.map(option),
		effortOptions: settings.effortOptions.map(option),
		permissionOptions: settings.permissionOptions.map(option),
	};
}

/** Runs a launch-pill command where the launch selection is owned: through
 * the same `settings.*` handlers the pane publishes for `dure client pane
 * act`, so their availability and revision checks apply to every caller. */
export function agentLaunchSelectionCommandRunner(
	{ actions }: AgentRuntimeSettings,
	launch: Pick<
		AgentRuntimeLaunchSelectionView,
		"retryHydration" | "dismissError"
	>,
): AgentLaunchSelectionSurface["run"] {
	return async (command) => {
		switch (command.kind) {
			case "select": {
				const action =
					command.field === "model"
						? actions["settings.model"]
						: command.field === "effort"
							? actions["settings.effort"]
							: actions["settings.permission"];
				await action({ value: command.value });
				return;
			}
			case "apply_pending":
				await actions["settings.applyPending"]();
				return;
			case "cancel_pending":
				await actions["settings.cancelPending"]();
				return;
			case "load_catalog":
				await actions["settings.catalog"]();
				return;
			case "retry_hydration":
				launch.retryHydration();
				return;
			case "dismiss_error":
				launch.dismissError();
				return;
		}
	};
}

const MAX_TEXT = 4_096;
const MAX_OPTIONS = 256;

function text(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_TEXT;
}

function nullableText(value: unknown): value is string | null {
	return value === null || text(value);
}

function parseOptions(
	value: unknown,
): AgentLaunchSelectionOptionV1[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_OPTIONS) return undefined;
	const options: AgentLaunchSelectionOptionV1[] = [];
	for (const candidate of value) {
		if (
			!isRecord(candidate) ||
			!nonEmptyString(candidate.value) ||
			!text(candidate.value) ||
			!text(candidate.label) ||
			(candidate.tone !== undefined && candidate.tone !== "danger")
		)
			return undefined;
		options.push({
			value: candidate.value,
			label: candidate.label,
			...(candidate.tone ? { tone: candidate.tone } : {}),
		});
	}
	return options;
}

function parsePending(
	value: unknown,
): AgentLaunchSelectionPresentationV1["pending"] | undefined {
	if (!isRecord(value) || !isRecord(value.selection)) return undefined;
	const { selection } = value;
	if (
		!nonEmptyString(value.requestId) ||
		!text(value.requestId) ||
		(value.error !== undefined && !text(value.error)) ||
		!nullableText(selection.model) ||
		!nullableText(selection.effort) ||
		!isProviderPermissionMode(selection.permissionMode)
	)
		return undefined;
	return {
		requestId: value.requestId,
		selection: {
			model: selection.model,
			effort: selection.effort,
			permissionMode: selection.permissionMode,
		},
		...(value.error !== undefined ? { error: value.error } : {}),
	};
}

/** A presentation another window sent, or undefined when it is malformed. */
export function parseAgentLaunchSelectionPresentation(
	value: unknown,
): AgentLaunchSelectionPresentationV1 | undefined {
	if (!isRecord(value) || !isRecord(value.catalog)) return undefined;
	const { catalog } = value;
	const pending =
		value.pending === undefined ? undefined : parsePending(value.pending);
	const modelOptions = parseOptions(value.modelOptions);
	const effortOptions = parseOptions(value.effortOptions);
	const permissionOptions = parseOptions(value.permissionOptions);
	if (
		typeof value.loaded !== "boolean" ||
		typeof value.hydrationError !== "boolean" ||
		typeof value.switching !== "boolean" ||
		!nullableText(value.model) ||
		!nullableText(value.effort) ||
		!isProviderPermissionMode(value.permissionMode) ||
		!nullableText(value.error) ||
		(value.errorMessage !== undefined && !text(value.errorMessage)) ||
		(value.pending !== undefined && !pending) ||
		!nullableText(value.observedModel) ||
		typeof catalog.offered !== "boolean" ||
		(catalog.status !== "idle" &&
			catalog.status !== "loading" &&
			catalog.status !== "failed") ||
		!modelOptions ||
		!effortOptions ||
		!permissionOptions
	)
		return undefined;
	return {
		loaded: value.loaded,
		hydrationError: value.hydrationError,
		model: value.model,
		effort: value.effort,
		permissionMode: value.permissionMode,
		switching: value.switching,
		error: value.error,
		...(value.errorMessage !== undefined
			? { errorMessage: value.errorMessage }
			: {}),
		...(pending ? { pending } : {}),
		observedModel: value.observedModel,
		catalog: { offered: catalog.offered, status: catalog.status },
		modelOptions,
		effortOptions,
		permissionOptions,
	};
}

/** A command another window sent, or undefined when it is malformed. */
export function parseAgentLaunchSelectionCommand(
	value: unknown,
): AgentLaunchSelectionCommand | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "select") {
		return SELECTION_FIELDS.includes(
			value.field as AgentLaunchSelectionField,
		) && nullableText(value.value)
			? {
					kind: "select",
					field: value.field as AgentLaunchSelectionField,
					value: value.value,
				}
			: undefined;
	}
	const kind = PLAIN_COMMANDS.find((candidate) => candidate === value.kind);
	return kind ? { kind } : undefined;
}
