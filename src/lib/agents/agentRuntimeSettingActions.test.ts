import { describe, expect, it, vi } from "vitest";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";
import type { AgentRuntimeLaunchSelectionView } from "./agentRuntimeLaunchSelection";
import { agentRuntimeSettingActions } from "./agentRuntimeSettingActions";

function fixture(busy = false) {
	const launch: AgentRuntimeLaunchSelectionView = {
		ownerKey: "fixture-runtime",
		loaded: true,
		hydrationError: false,
		model: "gpt-5.6-sol",
		effort: "high",
		permissionMode: "default",
		switching: busy,
		error: null,
		switchSelection: vi.fn(async () => ({ outcome: "applied" as const })),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
	};
	return {
		launch,
		...agentRuntimeSettingActions({
			provider: "codex",
			launch,
			models: codexModelCatalog,
			observedModel: null,
			busy,
		}),
	};
}

describe("shared runtime setting actions", () => {
	it.each([
		{
			action: "settings.model" as const,
			value: "gpt-5.6-luna",
			expected: {
				model: "gpt-5.6-luna",
				effort: null,
				permissionMode: "skip_permissions",
			},
		},
		{
			action: "settings.effort" as const,
			value: "high",
			expected: {
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "skip_permissions",
			},
		},
		{
			action: "settings.permission" as const,
			value: "default",
			expected: {
				model: "gpt-5.6-sol",
				effort: "ultra",
				permissionMode: "default",
			},
		},
	])(
		"derives $action from the authoritative action-time selection",
		async ({ action, value, expected }) => {
			const { launch, actions } = fixture();
			await actions[action]({
				value,
				expectedSourceRevision: 7,
				expectedConversationId: "original",
			});
			const [update, expectation] = vi.mocked(launch.switchSelection).mock
				.calls[0];
			expect(
				update({
					model: "gpt-5.6-sol",
					effort: "ultra",
					permissionMode: "skip_permissions",
				}),
			).toEqual(expected);
			expect(expectation).toEqual({
				expectedSourceRevision: 7,
				expectedConversationId: "original",
			});
		},
	);

	it("exposes the pending value and requires the observed request for apply or cancel", async () => {
		const { launch } = fixture();
		const applyPendingNow = vi.fn(async () => {});
		const cancelPending = vi.fn(() => true);
		const { actions } = agentRuntimeSettingActions({
			provider: "codex",
			models: codexModelCatalog,
			observedModel: null,
			busy: false,
			launch: {
				...launch,
				applyPendingNow,
				cancelPending,
				pending: {
					requestId: "pending-2",
					selection: {
						model: "gpt-5.6-sol",
						effort: "xhigh",
						permissionMode: "skip_permissions",
					},
				},
			},
		});
		expect(actions["settings.permission"].definition.current).toMatchObject({
			value: "default",
			pendingValue: "skip_permissions",
			pendingRequestId: "pending-2",
		});
		expect(
			await actions["settings.applyPending"]({
				expectedRequestId: "pending-old",
			}),
		).toMatchObject({ outcome: "refused" });
		expect(applyPendingNow).not.toHaveBeenCalled();
		expect(
			await actions["settings.applyPending"]({
				expectedRequestId: "pending-2",
			}),
		).toMatchObject({ outcome: "applied" });
		expect(applyPendingNow).toHaveBeenCalledOnce();
		expect(
			await actions["settings.cancelPending"]({
				expectedRequestId: "pending-2",
			}),
		).toMatchObject({ outcome: "applied" });
		expect(cancelPending).toHaveBeenCalledOnce();
	});

	it("refuses unsupported provider choices and busy panes without invoking a switch", async () => {
		const ready = fixture();
		expect(
			await ready.actions["settings.model"]({ value: "invented-model" }),
		).toMatchObject({ outcome: "refused" });
		expect(ready.launch.switchSelection).not.toHaveBeenCalled();
		const busy = fixture(true);
		expect(
			await busy.actions["settings.permission"]({ value: "default" }),
		).toMatchObject({
			outcome: "refused",
			error: { code: "pane_action_busy" },
		});
		expect(busy.launch.switchSelection).not.toHaveBeenCalled();
	});
});
