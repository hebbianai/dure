// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasDurableRemoteHmuxPaneReference,
	registerRemoteHmuxPaneDurably,
	remoteHmuxMountedPaneApplies,
	remoteHmuxPaneRegistrationApplies,
} from "@/lib/hmux/remote/remoteHmuxPaneRegistration";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import {
	appendPanelToLayout,
	panelsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
} from "@/store";
import type { SshHostConfig } from "@/types";

const spaceId = "space-1";
const host: SshHostConfig = {
	id: "host-1",
	name: "Remote",
	sshConfigAlias: "gateway-a",
	host: "remote.example.test",
	port: 22,
	user: "dure",
	auth: "auto",
};

function emptyLayout(): Record<string, unknown> {
	return {
		grid: {
			root: { type: "branch", data: [], size: 400 },
			width: 600,
			height: 400,
			orientation: "HORIZONTAL",
		},
		panels: {},
	};
}

function state(patch: Partial<PersistedAppState> = {}): PersistedAppState {
	return {
		...normalizePersistedState({}),
		spaces: [{ id: spaceId, name: "Main" }],
		sshHosts: [host],
		layouts: { [spaceId]: emptyLayout() },
		...patch,
	};
}

async function install(value: PersistedAppState): Promise<void> {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: { state: value, version: PERSIST_VERSION },
		result: undefined,
	}));
}

function read(): PersistedAppState {
	return (
		JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null") as {
			state: PersistedAppState;
		}
	).state;
}

const binding = {
	schemaVersion: 1,
	runtime: "hmux_standalone_v1",
	source: "ssh",
	hostId: host.id,
	sessionId: "session-remote",
	workspaceId: "workspace-remote",
	commandBridgeNonce: "bridge-remote",
} as const;

const registration = {
	host,
	spaceId,
	panelId: "term:remote",
	binding,
	definition: {
		id: "term:remote",
		contentComponent: "terminal",
		title: "Remote",
		params: {
			sessionId: "session-remote",
			binding,
		},
	},
	fallbackLayout: emptyLayout(),
} as const;

/** Panel ids a real Dockview mounts from the layout; its component factory
 * rejects unknown view names the way dockview-react does. */
function loadedPanelIds(layout: unknown): string[] {
	const container = document.createElement("div");
	document.body.append(container);
	try {
		const api = createDockview(container, {
			createComponent: (options) => {
				if (options.name !== "terminal") {
					throw new Error(`unknown pane component ${options.name}`);
				}
				const element = document.createElement("div");
				return {
					element,
					init() {},
					dispose() {
						element.remove();
					},
				};
			},
		});
		try {
			api.layout(600, 400);
			api.fromJSON(layout as never);
			return api.panels.map((panel) => panel.id);
		} finally {
			api.dispose();
		}
	} finally {
		container.remove();
	}
}

function placedLayout(
	definition: Readonly<Record<string, unknown>> = registration.definition,
): Record<string, unknown> {
	const layout = appendPanelToLayout(
		emptyLayout(),
		registration.panelId,
		definition,
	);
	if (!layout) throw new Error("test pane layout could not be created");
	return layout as Record<string, unknown>;
}

describe("remote Hmux pane durable registration", () => {
	beforeEach(async () => {
		localStorage.clear();
		await install(state());
	});

	it.each(["slot", "launcher:previous", "agent:previous"])(
		"replaces %s through the durable writer and replays only the accepted registration",
		async (paneId) => {
			const pane = {
				id: paneId,
				component: "launcher",
				params: { cwd: "/repo", hostId: host.id },
			};
			const definition = {
				id: paneId,
				contentComponent: pane.component,
				params: pane.params,
				title: "renamed during creation",
			};
			const prior = appendPanelToLayout(emptyLayout(), paneId, definition);
			const layout = appendPanelToLayout(prior, "peer", {
				id: "peer",
				contentComponent: "terminal",
				params: { sessionId: "keep" },
			});
			await install(state({ layouts: { [spaceId]: layout } }));
			const isCurrent = vi.fn(() => true);
			const replacing = {
				...registration,
				panelId: paneId,
				definition: { ...registration.definition, id: paneId },
				replacement: { pane, isCurrent },
			};
			await expect(registerRemoteHmuxPaneDurably(replacing)).resolves.toBe(
				true,
			);
			const after = read().layouts[spaceId];
			expect(after).toEqual({
				...(layout as object),
				panels: {
					[paneId]: replacing.definition,
					peer: {
						id: "peer",
						contentComponent: "terminal",
						params: { sessionId: "keep" },
					},
				},
			});
			expect(loadedPanelIds(after)).toEqual([paneId, "peer"]);
			isCurrent.mockReturnValue(false);
			await expect(registerRemoteHmuxPaneDurably(replacing)).resolves.toBe(
				true,
			);
			expect(read().layouts[spaceId]).toEqual(after);
			await expect(
				registerRemoteHmuxPaneDurably({
					...replacing,
					definition: {
						...replacing.definition,
						params: { ...replacing.definition.params, sessionId: "late" },
					},
				}),
			).resolves.toBe(false);
			expect(read().layouts[spaceId]).toEqual(after);
		},
	);

	it.each(["closed", "changed", "old-handle"])(
		"preserves a %s replacement target",
		async (failure) => {
			const pane = {
				id: "slot",
				component: "launcher",
				params: { cwd: "/repo" },
			};
			const layout =
				failure === "closed"
					? emptyLayout()
					: appendPanelToLayout(emptyLayout(), pane.id, {
							id: pane.id,
							contentComponent: failure === "changed" ? "agent" : "launcher",
							params: pane.params,
						});
			await install(state({ layouts: { [spaceId]: layout } }));
			await expect(
				registerRemoteHmuxPaneDurably({
					...registration,
					panelId: pane.id,
					definition: { ...registration.definition, id: pane.id },
					replacement: { pane, isCurrent: () => failure !== "old-handle" },
				}),
			).resolves.toBe(false);
			expect(read().layouts[spaceId]).toEqual(layout);
		},
	);

	it("registers the pane under the exact Host in one durable transaction", async () => {
		await expect(registerRemoteHmuxPaneDurably(registration)).resolves.toBe(
			true,
		);

		expect(remoteHmuxPaneRegistrationApplies(registration, read())).toBe(true);
		expect(
			panelsFromLayout(read().layouts[spaceId]).map((panel) => panel.id),
		).toEqual([registration.panelId]);
		await expect(hasDurableRemoteHmuxPaneReference(registration)).resolves.toBe(
			true,
		);
	});

	it("writes a layout a real Dockview loads as a terminal pane", async () => {
		await expect(registerRemoteHmuxPaneDurably(registration)).resolves.toBe(
			true,
		);

		expect(loadedPanelIds(read().layouts[spaceId])).toEqual([
			registration.panelId,
		]);
	});

	it("repairs a neighbour written with addPanel's `component` key on register", async () => {
		const legacy = appendPanelToLayout(emptyLayout(), "term:legacy", {
			id: "term:legacy",
			component: "terminal",
			params: {},
		});
		if (!legacy) throw new Error("legacy pane layout could not be created");
		await install(state({ layouts: { [spaceId]: legacy } }));

		await expect(registerRemoteHmuxPaneDurably(registration)).resolves.toBe(
			true,
		);

		expect(loadedPanelIds(read().layouts[spaceId]).sort()).toEqual([
			"term:legacy",
			registration.panelId,
		]);
	});

	it("commits requested placement through the durable layout writer", async () => {
		const referenced = appendPanelToLayout(emptyLayout(), "term:reference", {
			id: "term:reference",
			contentComponent: "terminal",
			params: {},
		});
		if (!referenced) throw new Error("reference pane could not be created");
		await install(state({ layouts: { [spaceId]: referenced } }));

		await expect(
			registerRemoteHmuxPaneDurably({
				...registration,
				position: {
					referencePanel: "term:reference",
					direction: "below",
				},
			}),
		).resolves.toBe(true);

		const layout = read().layouts[spaceId] as {
			grid: { root: { data: Array<Record<string, unknown>> } };
		};
		expect(layout.grid.root.data[0]).toMatchObject({
			type: "branch",
			data: [
				{ type: "leaf", data: { views: ["term:reference"] } },
				{ type: "leaf", data: { views: [registration.panelId] } },
			],
		});
	});

	it("accepts only the exact mounted pane params", () => {
		expect(
			remoteHmuxMountedPaneApplies(registration, {
				params: registration.definition.params,
			}),
		).toBe(true);
		expect(
			remoteHmuxMountedPaneApplies(registration, {
				params: {
					...registration.definition.params,
					binding: { ...binding, commandBridgeNonce: "bridge-successor" },
				},
			}),
		).toBe(false);
	});

	it("rejects a same-id Host successor without publishing the pane", async () => {
		const successor = { ...host, sshConfigAlias: "gateway-b" };
		await install(state({ sshHosts: [successor] }));

		await expect(registerRemoteHmuxPaneDurably(registration)).resolves.toBe(
			false,
		);

		expect(panelsFromLayout(read().layouts[spaceId])).toEqual([]);
		expect(read().sshHosts).toEqual([successor]);
		expect(remoteHmuxPaneRegistrationApplies(registration, read())).toBe(false);
	});

	it("adopts an exact existing registration without rewriting it", async () => {
		await registerRemoteHmuxPaneDurably(registration);
		const before = localStorage.getItem(DURABLE_APP_STORE_NAME);

		await expect(registerRemoteHmuxPaneDurably(registration)).resolves.toBe(
			true,
		);

		expect(localStorage.getItem(DURABLE_APP_STORE_NAME)).toBe(before);
	});

	it("reports an unreferenced session after its durable pane is gone", async () => {
		await expect(hasDurableRemoteHmuxPaneReference(registration)).resolves.toBe(
			false,
		);
	});

	it("recognizes the exact pane after a durable move to another Space", async () => {
		const movedSpaceId = "space-2";
		await install(
			state({
				spaces: [
					{ id: spaceId, name: "Main" },
					{ id: movedSpaceId, name: "Moved" },
				],
				layouts: {
					[spaceId]: emptyLayout(),
					[movedSpaceId]: placedLayout(),
				},
			}),
		);

		await expect(hasDurableRemoteHmuxPaneReference(registration)).resolves.toBe(
			true,
		);
	});

	it.each([
		["workspace", { ...binding, workspaceId: "workspace-successor" }],
		["nonce", { ...binding, commandBridgeNonce: "bridge-successor" }],
	])(
		"rejects a pane with a different %s generation",
		async (_label, nextBinding) => {
			const definition = {
				...registration.definition,
				params: { ...registration.definition.params, binding: nextBinding },
			};
			await install(
				state({ layouts: { [spaceId]: placedLayout(definition) } }),
			);

			await expect(
				hasDurableRemoteHmuxPaneReference(registration),
			).resolves.toBe(false);
		},
	);

	it("ignores an unplaced panel definition", async () => {
		await install(
			state({
				layouts: {
					[spaceId]: {
						...emptyLayout(),
						panels: { [registration.panelId]: registration.definition },
					},
				},
			}),
		);

		await expect(hasDurableRemoteHmuxPaneReference(registration)).resolves.toBe(
			false,
		);
	});

	it("rejects an exact pane retained by a same-id Host successor", async () => {
		await install(
			state({
				sshHosts: [{ ...host, sshConfigAlias: "gateway-b" }],
				layouts: { [spaceId]: placedLayout() },
			}),
		);

		await expect(hasDurableRemoteHmuxPaneReference(registration)).resolves.toBe(
			false,
		);
	});
});
