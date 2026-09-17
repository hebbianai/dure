import { describe, expect, it } from "vitest";
import {
	applyHmuxSessionConversionSync,
	classifyHmuxConversionBinding,
	hmuxSessionConversionId,
	projectHmuxConversionLayout,
	selectHmuxConversionSourceBinding,
	type ConvertibleHmuxBinding,
	type HmuxSessionConversionSyncPayload,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import { resolveHmuxManagedAgentPromotion } from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const source = hmuxStandaloneBinding("source-session", "workspace-1");
const PANEL_ID = "agent:agent-1" as const;
const target = {
	...hmuxManagedBinding("target-session", "workspace-1"),
	createIdempotencyKey: "conversion-1",
};
const payload: HmuxSessionConversionSyncPayload = {
	schemaVersion: 1,
	desktopId: "desktop-1",
	panelId: PANEL_ID,
	agentId: "agent-1",
	providerId: "codex",
	cwd: "/repo/worktree",
	conversationId: "019fa9b6-9907-70f2-877b-5f07907bd2ba",
	sourceBinding: source,
	binding: target,
};

function layout(binding: ConvertibleHmuxBinding) {
	return {
		panels: {
			[PANEL_ID]: {
				id: PANEL_ID,
				contentComponent: "agent",
				params: {
					agentRef: { agentId: "agent-1" },
					agentId: "agent-1",
					sessionId: binding.sessionId,
					binding,
				},
			},
		},
	};
}

function agent(binding: ConvertibleHmuxBinding): Agent {
	return agentFixture({
		name: "codex-1",
		worktreePath: payload.cwd,
		branch: "agent/codex-1",
		sessionId: binding.sessionId,
		conversationId: payload.conversationId,
		runtimeBinding: binding,
	});
}

describe("Hmux session conversion CAS", () => {
	it.each(["pane-opaque", "agent:previous"])(
		"preserves the explicit Agent reference in %s during conversion projection",
		(panelId) => {
			const before = {
				panels: {
					[panelId]: {
						contentComponent: "agent",
						params: { agentRef: { agentId: "agent-1" }, binding: source },
					},
				},
			};
			const projected = projectHmuxConversionLayout(before, {
				...payload,
				panelId,
			});
			expect(projected).toEqual({
				state: "target",
				layout: {
					panels: {
						[panelId]: {
							contentComponent: "agent",
							params: { agentRef: { agentId: "agent-1" } },
						},
					},
				},
			});
			expect(before.panels[panelId].params.binding).toEqual(source);
			expect(
				projectHmuxConversionLayout(projected.layout, { ...payload, panelId }),
			).toEqual(projected);
		},
	);

	it("does not apply a late conversion to a different current Agent", () => {
		const before = {
			panels: {
				[PANEL_ID]: {
					contentComponent: "agent",
					params: { agentRef: { agentId: "replacement" } },
				},
			},
		};
		expect(projectHmuxConversionLayout(before, payload)).toEqual({
			state: "conflict",
			layout: before,
		});
	});

	it("updates terminal content without turning its historical Agent ID into an Agent reference", () => {
		const before = {
			panels: {
				[PANEL_ID]: {
					contentComponent: "terminal",
					params: { sessionId: source.sessionId, binding: source },
				},
			},
		};
		expect(projectHmuxConversionLayout(before, payload)).toEqual({
			state: "source",
			layout: {
				panels: {
					[PANEL_ID]: {
						contentComponent: "terminal",
						params: { sessionId: target.sessionId, binding: target },
					},
				},
			},
		});
	});

	it("does not apply copied conversion parameters after content replacement", () => {
		const panelId = "term:previous";
		const before = {
			panels: {
				[panelId]: {
					contentComponent: "pane-launcher",
					params: { sessionId: source.sessionId, binding: source },
				},
			},
		};
		expect(
			projectHmuxConversionLayout(before, { ...payload, panelId }),
		).toEqual({ state: "conflict", layout: before });
	});

	it("recovers the exact source from mixed source/target consumers", () => {
		expect(
			selectHmuxConversionSourceBinding(
				[target, source, target],
				"managed",
				source.sessionId,
				source.workspaceId,
			),
		).toEqual(source);
	});

	it("treats an all-target state as already converged instead of replaying destructively", () => {
		expect(() =>
			selectHmuxConversionSourceBinding(
				[target, target],
				"managed",
				source.sessionId,
				source.workspaceId,
			),
		).toThrow(/already managed/);
	});

	it("refuses a conflicting-source recovery state", () => {
		expect(() =>
			selectHmuxConversionSourceBinding(
				[source, hmuxStandaloneBinding("other-source", source.workspaceId)],
				"managed",
				source.sessionId,
				source.workspaceId,
			),
		).toThrow(/disagree/);
	});

	it("classifies only the exact source and target identities", () => {
		expect(classifyHmuxConversionBinding(source, source, target)).toBe(
			"source",
		);
		expect(classifyHmuxConversionBinding(target, source, target)).toBe(
			"target",
		);
		expect(classifyHmuxConversionBinding(undefined, source, target)).toBe(
			"missing",
		);
		expect(
			classifyHmuxConversionBinding(
				hmuxStandaloneBinding("other-session", "workspace-1"),
				source,
				target,
			),
		).toBe("conflict");
		expect(
			classifyHmuxConversionBinding(
				{ ...target, credentialId: "other-credential" },
				source,
				target,
			),
		).toBe("conflict");
	});

	it("normalizes legacy Agent pane runtime fields without treating them as authority", () => {
		const before = layout(source);
		const projected = projectHmuxConversionLayout(before, payload);

		expect(projected.state).toBe("target");
		expect(before.panels[PANEL_ID].params.binding).toEqual(source);
		expect(
			(projected.layout as ReturnType<typeof layout>).panels[PANEL_ID].params,
		).toEqual({ agentRef: { agentId: "agent-1" } });
	});

	it("is idempotent and ignores every legacy pane runtime identity", () => {
		const alreadyApplied = projectHmuxConversionLayout(layout(target), payload);
		expect(alreadyApplied.state).toBe("target");
		expect(
			(alreadyApplied.layout as ReturnType<typeof layout>).panels[PANEL_ID]
				.params,
		).toEqual({ agentRef: { agentId: "agent-1" } });

		const staleThird = projectHmuxConversionLayout(
			layout(hmuxStandaloneBinding("other-session", "workspace-1")),
			payload,
		);
		expect(staleThird.state).toBe("target");
	});

	it("reports a missing pane without inventing layout state", () => {
		const empty = { panels: {} };
		expect(projectHmuxConversionLayout(empty, payload)).toEqual({
			state: "missing",
			layout: empty,
		});
	});

	it.each([
		["source", source, source],
		["agent-target", target, source],
		["layout-target", source, target],
		["target", target, target],
	] as const)(
		"converges the %s Agent/layout state to the exact target",
		(_name, agentBinding, layoutBinding) => {
			useStore.setState({
				agents: [agent(agentBinding)],
				layouts: { [payload.desktopId]: layout(layoutBinding) },
				sessionCwd: {
					[source.sessionId]: payload.cwd,
					[target.sessionId]: "/stale",
				},
			});

			expect(applyHmuxSessionConversionSync(payload)).toBe(true);
			const state = useStore.getState();
			expect(state.agents[0]).toMatchObject({
				sessionId: target.sessionId,
				runtimeBinding: target,
				conversationId: payload.conversationId,
			});
			expect(
				(state.layouts[payload.desktopId] as ReturnType<typeof layout>).panels[
					PANEL_ID
				].params,
			).toEqual({ agentRef: { agentId: "agent-1" } });
			expect(state.sessionCwd[source.sessionId]).toBeUndefined();
			expect(state.sessionCwd[target.sessionId]).toBe(payload.cwd);
		},
	);

	it("converges managed to standalone when the cwd-derived workspace changes", () => {
		const managedSource = hmuxManagedBinding(
			"managed-source",
			"project-workspace",
		);
		const standaloneTarget = hmuxStandaloneBinding(
			"standalone-target",
			"cwd-workspace",
		);
		const reversePayload: HmuxSessionConversionSyncPayload = {
			...payload,
			sourceBinding: managedSource,
			binding: standaloneTarget,
		};
		useStore.setState({
			agents: [agent(managedSource)],
			layouts: {
				[payload.desktopId]: layout(managedSource),
			},
			sessionCwd: {
				[managedSource.sessionId]: payload.cwd,
			},
		});

		expect(applyHmuxSessionConversionSync(reversePayload)).toBe(true);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: standaloneTarget.sessionId,
			runtimeBinding: standaloneTarget,
			conversationId: payload.conversationId,
		});
	});

	it("atomically creates an Agent registry record and AgentPanel for a standalone terminal", () => {
		const sourcePanelId = "term:source-session";
		const conversionId = hmuxSessionConversionId(
			sourcePanelId,
			source,
			"managed",
		);
		const promotion = resolveHmuxManagedAgentPromotion({
			sourcePanelId,
			conversionId,
			providerId: "codex",
			cwd: payload.cwd,
			sourceBinding: source,
			currentBinding: source,
			preferredName: "hmux-codex",
			terminalEnvironment: { TERM: "xterm-256color" },
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			detected: {},
			agents: [],
		});
		const promotionPayload: HmuxSessionConversionSyncPayload = {
			...payload,
			panelId: sourcePanelId,
			agentId: promotion.agentId,
			promotion,
		};
		const terminalLayout = {
			grid: {
				root: {
					type: "branch",
					data: [
						{
							type: "leaf",
							data: {
								id: "group-1",
								views: [sourcePanelId],
								activeView: sourcePanelId,
							},
						},
					],
				},
			},
			panels: {
				[sourcePanelId]: {
					id: sourcePanelId,
					contentComponent: "terminal",
					params: {
						sessionId: source.sessionId,
						binding: source,
					},
				},
			},
			activeGroup: "group-1",
		};
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [],
			agentActivity: {},
			layouts: { [payload.desktopId]: terminalLayout },
			sessionCwd: { [source.sessionId]: payload.cwd },
		});

		expect(applyHmuxSessionConversionSync(promotionPayload)).toBe(true);
		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({
				id: promotion.agentId,
				name: "hmux-codex",
				projectId: "project-1",
				sessionId: target.sessionId,
				runtimeBinding: target,
				conversationId: payload.conversationId,
				terminalEnv: { TERM: "xterm-256color" },
			}),
		]);
		const promotedLayout = useStore.getState().layouts[payload.desktopId] as {
			panels: Record<string, { contentComponent: string }>;
			grid: {
				root: {
					data: Array<{ data: { views: string[]; activeView: string } }>;
				};
			};
		};
		expect(promotion.targetPanelId).toBe(sourcePanelId);
		expect(promotedLayout.panels[promotion.targetPanelId]).toMatchObject({
			contentComponent: "agent",
		});
		expect(promotedLayout.grid.root.data[0].data).toMatchObject({
			views: [promotion.targetPanelId],
			activeView: promotion.targetPanelId,
		});
		expect(useStore.getState().agentActivity[promotion.agentId]).toBe(
			"waiting",
		);

		expect(applyHmuxSessionConversionSync(promotionPayload)).toBe(true);
		expect(
			useStore
				.getState()
				.agents.filter((candidate) => candidate.id === promotion.agentId),
		).toHaveLength(1);
	});

	it("promotes a fenced managed local shell through the same conversion payload", () => {
		const sourcePanelId = "term:managed-shell";
		const managedShell = {
			...hmuxManagedBinding(
				"managed-shell",
				"dure-local-shells-v1",
				undefined,
				undefined,
				{
					runnerPrincipal: "runner-source",
					runnerInstance: "instance-source",
					channelEpoch: "1",
					hostInstanceId: "host-source",
					terminalEpoch: "terminal-source",
				},
			),
			createIdempotencyKey: "shell_managed-shell",
		};
		if (!isHmuxProviderSessionSourceBinding(managedShell, "terminal")) {
			throw new Error("managed shell fixture is not a provider source");
		}
		const managedTarget = {
			...hmuxManagedBinding("managed-target", managedShell.workspaceId),
			createIdempotencyKey: "convert-managed-shell",
		};
		const conversionId = hmuxSessionConversionId(
			sourcePanelId,
			managedShell,
			"managed",
		);
		const promotion = resolveHmuxManagedAgentPromotion({
			sourcePanelId,
			conversionId,
			providerId: "codex",
			cwd: payload.cwd,
			sourceBinding: managedShell,
			currentBinding: managedShell,
			preferredName: "managed-shell",
			terminalEnvironment: {},
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			detected: {},
			agents: [],
		});
		useStore.setState({
			agents: [],
			agentActivity: {},
			layouts: {
				[payload.desktopId]: {
					panels: {
						[sourcePanelId]: {
							id: sourcePanelId,
							contentComponent: "terminal",
							params: {
								sessionId: managedShell.sessionId,
								binding: managedShell,
							},
						},
					},
				},
			},
			sessionCwd: { [managedShell.sessionId]: payload.cwd },
		});
		expect(
			applyHmuxSessionConversionSync({
				...payload,
				panelId: sourcePanelId,
				agentId: undefined,
				promotion: undefined,
				sourceBinding: managedShell,
				binding: managedTarget,
			}),
		).toBe(false);

		expect(
			applyHmuxSessionConversionSync({
				...payload,
				panelId: sourcePanelId,
				agentId: promotion.agentId,
				promotion,
				sourceBinding: managedShell,
				binding: managedTarget,
			}),
		).toBe(true);
		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({
				id: promotion.agentId,
				sessionId: managedTarget.sessionId,
				runtimeBinding: managedTarget,
				conversationId: payload.conversationId,
			}),
		]);
		const next = useStore.getState().layouts[payload.desktopId] as {
			panels: Record<string, { contentComponent: string }>;
		};
		expect(promotion.targetPanelId).toBe(sourcePanelId);
		expect(next.panels[promotion.targetPanelId]).toMatchObject({
			contentComponent: "agent",
		});
	});

	it("converges a reviewed Claude terminal promotion through the same Agent pane path", () => {
		const sourcePanelId = "term:claude-source";
		const conversionId = hmuxSessionConversionId(
			sourcePanelId,
			source,
			"managed",
		);
		const promotion = resolveHmuxManagedAgentPromotion({
			sourcePanelId,
			conversionId,
			providerId: "claude",
			cwd: payload.cwd,
			sourceBinding: source,
			currentBinding: source,
			preferredName: "hmux-claude",
			terminalEnvironment: {},
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			detected: {},
			agents: [],
		});
		const terminalLayout = {
			panels: {
				[sourcePanelId]: {
					id: sourcePanelId,
					contentComponent: "terminal",
					params: {
						sessionId: source.sessionId,
						binding: source,
					},
				},
			},
		};
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [],
			agentActivity: {},
			layouts: { [payload.desktopId]: terminalLayout },
			sessionCwd: { [source.sessionId]: payload.cwd },
		});

		expect(
			applyHmuxSessionConversionSync({
				...payload,
				panelId: sourcePanelId,
				agentId: promotion.agentId,
				promotion,
				providerId: "claude",
			}),
		).toBe(true);
		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({
				id: promotion.agentId,
				provider: "claude",
				runtimeBinding: target,
				accountId: null,
			}),
		]);
		const promotedLayout = useStore.getState().layouts[payload.desktopId] as {
			panels: Record<string, { contentComponent: string }>;
		};
		expect(promotion.targetPanelId).toBe(sourcePanelId);
		expect(promotedLayout.panels[promotion.targetPanelId]).toMatchObject({
			contentComponent: "agent",
		});
	});

	it("refuses a sync payload that would reuse an unrelated same-name Agent", () => {
		const sourcePanelId = "term:source-session";
		const conversionId = hmuxSessionConversionId(
			sourcePanelId,
			source,
			"managed",
		);
		const promotion = resolveHmuxManagedAgentPromotion({
			sourcePanelId,
			conversionId,
			providerId: "codex",
			cwd: payload.cwd,
			sourceBinding: source,
			currentBinding: source,
			preferredName: "hmux-codex-new",
			terminalEnvironment: {},
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			detected: {},
			agents: [],
		});
		useStore.setState({
			agents: [
				agent(source),
				{
					...agent(source),
					id: "agent-unrelated",
					name: promotion.agentName,
					sessionId: "unrelated",
					runtimeBinding: hmuxStandaloneBinding(
						"unrelated",
						source.workspaceId,
					),
				},
			],
			layouts: {},
		});

		expect(
			applyHmuxSessionConversionSync({
				...payload,
				panelId: sourcePanelId,
				agentId: promotion.agentId,
				promotion,
			}),
		).toBe(false);
		expect(
			useStore
				.getState()
				.agents.some((candidate) => candidate.id === promotion.agentId),
		).toBe(false);
	});
});
