import {
	definePaneAction,
	type PaneActionExecution,
} from "@/lib/workspace/pane/paneAction";
import type { Provider } from "@/types";
import type {
	AgentRuntimeLaunchExpectation,
	AgentRuntimeLaunchSelectionView,
} from "./agentRuntimeLaunchSelection";
import { agentRuntimeLaunchRejected } from "./agentRuntimeLaunchSelection";
import {
	catalogEffortOptions,
	catalogModelOptions,
	type ObservedProviderModelV1,
} from "./providerModels";
import { providerPermissionOptions } from "./providerPermissions";

/** Menu options and external actions are composed from the same provider catalog.
 * A model edit derives its effort from the action-time source, not this view. */
export function agentRuntimeSettingActions({
	provider,
	launch,
	models,
	observedModel,
	busy,
	refreshCatalog,
}: {
	provider: Provider;
	launch: AgentRuntimeLaunchSelectionView;
	models: readonly ObservedProviderModelV1[];
	observedModel: string | null;
	busy: boolean;
	refreshCatalog?: () => Promise<
		readonly ObservedProviderModelV1[] | undefined
	>;
}) {
	const modelOptions = catalogModelOptions(models);
	const permissionOptions = providerPermissionOptions(provider);
	const effortOptions = catalogEffortOptions(
		provider,
		models,
		(launch.pending
			? launch.pending.selection.model
			: launch.loaded
				? launch.model
				: null) ?? observedModel,
	);
	const unavailable = busy
		? {
				code: "pane_action_busy",
				message: "The pane is already changing its runtime.",
				retryable: true,
			}
		: undefined;
	const setting = (
		field: "model" | "effort" | "permissionMode",
		description: string,
		values: readonly (string | null)[],
		current: string | null,
		run: (
			value: string | null,
			expected: AgentRuntimeLaunchExpectation,
		) => Promise<PaneActionExecution>,
	) =>
		definePaneAction(
			{
				description,
				...(launch.error ? { error: launch.error } : {}),
				parameters: {
					value: {
						type: "string",
						required: true,
						nullable: values.includes(null),
						values,
					},
					expectedSourceRevision: {
						type: "integer",
						minimum: 1,
						description:
							"Selection revision observed before this request; refuses a concurrent change.",
					},
					expectedConversationId: {
						type: "string",
						description:
							"Conversation observed before this request; refuses a different conversation.",
					},
				},
				current: {
					...(launch.loaded ? { value: current } : {}),
					...(launch.pending
						? {
								pendingValue: launch.pending.selection[field],
								pendingRequestId: launch.pending.requestId,
							}
						: {}),
					...(launch.selectionRevision !== undefined
						? { selectionRevision: launch.selectionRevision }
						: {}),
					...(launch.conversationId !== undefined
						? { conversationId: launch.conversationId }
						: {}),
				},
				...(unavailable ? { unavailable } : {}),
			},
			({ value, expectedSourceRevision, expectedConversationId }) =>
				run(value as string | null, {
					...(expectedSourceRevision !== undefined
						? { expectedSourceRevision: expectedSourceRevision as number }
						: {}),
					...(expectedConversationId !== undefined
						? { expectedConversationId: expectedConversationId as string }
						: {}),
				}),
		);
	const pendingAction = (
		description: string,
		run: (() => Promise<PaneActionExecution>) | undefined,
	) =>
		definePaneAction(
			{
				description,
				parameters: { expectedRequestId: { type: "string" } },
				current: launch.pending ? { requestId: launch.pending.requestId } : {},
				unavailable:
					unavailable ??
					(!launch.pending || !run
						? {
								code: "settings_pending_missing",
								message: "There is no pending settings change.",
								retryable: false,
							}
						: undefined),
			},
			async ({ expectedRequestId }) => {
				if (
					expectedRequestId !== undefined &&
					expectedRequestId !== launch.pending?.requestId
				) {
					return {
						outcome: "refused",
						error: {
							code: "settings_pending_changed",
							message: "The pending settings change has changed.",
							retryable: true,
						},
					};
				}
				if (!run) return { outcome: "unchanged" };
				try {
					return await run();
				} catch (error) {
					return agentRuntimeLaunchRejected(error);
				}
			},
		);
	const { applyPendingNow, cancelPending } = launch;
	const actions = {
		"settings.applyPending": pendingAction(
			"Interrupt the current turn and apply the pending settings to the same conversation.",
			applyPendingNow
				? async () => {
						await applyPendingNow();
						return {
							outcome: "applied",
							value: { settings: launch.pending?.selection },
						};
					}
				: undefined,
		),
		"settings.cancelPending": pendingAction(
			"Cancel the pending settings change.",
			cancelPending
				? async () => ({ outcome: cancelPending() ? "applied" : "unchanged" })
				: undefined,
		),
		"settings.catalog": definePaneAction(
			{
				description:
					"Load the provider choices used by this pane's menus, then read pane state for updated action parameters.",
				parameters: {},
			},
			async () => {
				const observed = refreshCatalog ? await refreshCatalog() : models;
				return observed
					? { outcome: "applied", value: { models: observed } }
					: {
							outcome: "failed",
							error: {
								code: "provider_catalog_unavailable",
								message: "Provider choices could not be loaded.",
								retryable: true,
							},
						};
			},
		),
		"settings.model": setting(
			"model",
			"Select the model while preserving this conversation.",
			[null, ...modelOptions.map(({ value }) => value)],
			launch.model,
			(model, expected) =>
				launch.switchSelection(
					(source) => ({
						model,
						effort: catalogEffortOptions(provider, models, model).some(
							(option) => option.value === source.effort,
						)
							? source.effort
							: null,
						permissionMode: source.permissionMode,
					}),
					expected,
				),
		),
		"settings.effort": setting(
			"effort",
			"Select reasoning effort while preserving this conversation.",
			[null, ...effortOptions.map(({ value }) => value)],
			launch.effort,
			(effort, expected) =>
				launch.switchSelection((source) => ({ ...source, effort }), expected),
		),
		"settings.permission": setting(
			"permissionMode",
			"Select permission mode while preserving this conversation.",
			permissionOptions.map(({ value }) => value),
			launch.permissionMode,
			(permissionMode, expected) =>
				launch.switchSelection(
					(source) => ({
						...source,
						permissionMode: permissionMode as typeof source.permissionMode,
					}),
					expected,
				),
		),
	};
	return { actions, modelOptions, effortOptions, permissionOptions };
}
