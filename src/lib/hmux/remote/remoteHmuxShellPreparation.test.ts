// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { beginRemoteHmuxPaneTransition } from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import { hasDurableRemoteHmuxShellPreparation } from "@/lib/hmux/remote/remoteHmuxShellPreparation";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
} from "@/store";
import type { SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "remote",
	name: "Remote",
	host: "example.test",
	port: 22,
	user: "fixture",
	auth: "auto",
};
const binding = hmuxStandaloneBinding("source", "workspace");
const preparing = beginRemoteHmuxPaneTransition(
	binding,
	host.id,
	"operation-one",
);
function state(
	operation = preparing,
	panelId = "term:source",
	contentComponent = "terminal",
): PersistedAppState {
	return {
		...normalizePersistedState({}),
		spaces: [{ id: "space", name: "Space" }],
		sshHosts: [host],
		layouts: {
			space: {
				grid: {
					root: {
						type: "branch",
						data: [
							{
								type: "leaf",
								data: { views: [panelId], activeView: panelId },
							},
						],
					},
				},
				panels: {
					[panelId]: {
						id: panelId,
						contentComponent,
						params: {
							binding,
							sessionId: "source",
							remoteHmuxTransition: operation,
						},
					},
				},
			},
		},
	};
}
async function install(value: PersistedAppState) {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: { state: value, version: PERSIST_VERSION },
		result: undefined,
	}));
}
const admitted = () =>
	hasDurableRemoteHmuxShellPreparation("space", "term:source", host, preparing);

describe("durable SSH shell preparation", () => {
	beforeEach(async () => {
		await durableAppStorage.flush();
		localStorage.clear();
	});
	it("recovers the same operation from the serialized source pane", async () => {
		await install(state());
		expect(await admitted()).toBe(true);
		expect(
			await hasDurableRemoteHmuxShellPreparation("space", "term:source", host, {
				...preparing,
				createIdempotencyKey: "other",
			}),
		).toBe(false);
	});
	it.each(["pane-opaque", "agent:old"])(
		"recovers the exact terminal preparation in %s",
		async (panelId) => {
			await install(state(preparing, panelId));
			expect(
				await hasDurableRemoteHmuxShellPreparation(
					"space",
					panelId,
					host,
					preparing,
				),
			).toBe(true);
		},
	);
	it("refuses copied preparation after the same pane changes content", async () => {
		await install(state(preparing, "term:source", "pane-launcher"));
		expect(await admitted()).toBe(false);
	});
	it.each(["host", "space", "placement", "source"])(
		"refuses a changed durable %s before creation",
		async (changed) => {
			const value = state();
			if (changed === "host")
				value.sshHosts = [{ ...host, host: "different.test" }];
			if (changed === "space") value.spaces = [];
			const layout = value.layouts.space as FixtureLayout;
			if (changed === "placement") layout.grid.root.data = [];
			if (changed === "source")
				layout.panels["term:source"].params.binding = hmuxStandaloneBinding(
					"replacement",
					"workspace",
				);
			await install(value);
			expect(await admitted()).toBe(false);
		},
	);
	it("admits only the durable winner after two stale window projections flush", async () => {
		const initial = state();
		const layout = initial.layouts.space as FixtureLayout;
		delete layout.panels["term:source"].params.remoteHmuxTransition;
		await install(initial);
		const first = createReferenceAwareLocalStorage<PersistedAppState>({
			convergeState: convergePersistedAppState,
		});
		const second = createReferenceAwareLocalStorage<PersistedAppState>({
			convergeState: convergePersistedAppState,
		});
		first.getItem(DURABLE_APP_STORE_NAME);
		second.getItem(DURABLE_APP_STORE_NAME);
		const competitor = { ...preparing, createIdempotencyKey: "operation-two" };
		first.setItem(DURABLE_APP_STORE_NAME, {
			state: state(),
			version: PERSIST_VERSION,
		});
		second.setItem(DURABLE_APP_STORE_NAME, {
			state: state(competitor),
			version: PERSIST_VERSION,
		});
		await Promise.all([first.flush(), second.flush()]);
		expect(await admitted()).toBe(true);
		expect(
			await hasDurableRemoteHmuxShellPreparation(
				"space",
				"term:source",
				host,
				competitor,
			),
		).toBe(false);
	});
});

interface FixtureLayout {
	grid: { root: { data: unknown[] } };
	panels: {
		"term:source": {
			params: {
				binding: typeof binding;
				remoteHmuxTransition?: typeof preparing;
			};
		};
	};
}
