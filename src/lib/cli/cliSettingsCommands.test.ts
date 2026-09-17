import { describe, expect, it, vi } from "vitest";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";
import { dispatchCliSettingsRequest } from "./cliSettingsCommands";

const saved = {
	id: "existing",
	label: "Existing",
	text: "Keep me",
	appendEnter: true,
};
function fixture(claimed = true) {
	let prefs: UiPrefs = { ...DEFAULT_UI_PREFS, quickCommands: [saved] };
	const dependencies = {
		claim: vi.fn(async () => claimed),
		complete: vi.fn(
			async (_reqId: string, _result: unknown, _action: string) => undefined,
		),
		getPrefs: () => prefs,
		setPrefs: vi.fn((patch: Partial<UiPrefs>) => {
			prefs = { ...prefs, ...patch };
		}),
	};
	const run = async (
		params: Record<string, unknown>,
		action = "quick-commands",
	) => {
		await dispatchCliSettingsRequest(
			{ reqId: "request-1", action, params },
			dependencies,
		);
		const calls = dependencies.complete.mock.calls;
		return calls[calls.length - 1]?.[1];
	};
	return { dependencies, run };
}

describe("CLI settings authority", () => {
	it("updates one ID, preserves other preferences, and round-trips through persistence", async () => {
		const { dependencies, run } = fixture();
		const command = {
			id: "architecture",
			label: " Architecture ",
			text: "분석\n  개선\n",
			appendEnter: false,
		};
		await run({ operation: "put", command });
		await run({ operation: "put", command: { ...command, text: "Revised\n" } });
		expect(dependencies.getPrefs().quickCommands).toEqual([
			saved,
			{ ...command, label: "Architecture", text: "Revised\n" },
		]);
		expect(dependencies.getPrefs().theme).toBe(DEFAULT_UI_PREFS.theme);
		const persisted = persistedSlice(
			normalizePersistedState({ uiPrefs: dependencies.getPrefs() }),
		);
		expect(
			normalizePersistedState(JSON.parse(JSON.stringify(persisted))).uiPrefs
				.quickCommands,
		).toEqual(dependencies.getPrefs().quickCommands);
		expect(await run({ operation: "list" })).toEqual({
			ok: true,
			commands: dependencies.getPrefs().quickCommands,
		});
	});
	it("does not mutate or complete a request owned by another window", async () => {
		const { dependencies, run } = fixture(false);
		await run({ operation: "remove", id: saved.id });
		expect(dependencies.setPrefs).not.toHaveBeenCalled();
		expect(dependencies.complete).not.toHaveBeenCalled();
	});
	it("rejects malformed saved input without dropping existing commands", async () => {
		const { dependencies, run } = fixture();
		for (const command of [
			{ ...saved, text: "\u001b[200~" },
			{ ...saved, text: "x".repeat(16_001) },
			{ ...saved, appendEnter: undefined },
		]) {
			expect(await run({ operation: "put", command })).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
		}
		expect(dependencies.setPrefs).not.toHaveBeenCalled();
		expect(dependencies.getPrefs().quickCommands).toEqual([saved]);
	});
	it("removes only the requested command and converges when it is already absent", async () => {
		const { run } = fixture();
		expect(await run({ operation: "remove", id: "missing" })).toEqual({
			ok: true,
			id: "missing",
			removed: false,
		});
		expect(await run({ operation: "remove", id: saved.id })).toEqual({
			ok: true,
			id: saved.id,
			removed: true,
		});
		expect(await run({ operation: "remove", id: saved.id })).toEqual({
			ok: true,
			id: saved.id,
			removed: false,
		});
	});
	it("retains settings get/set and claims before their write", async () => {
		const { dependencies, run } = fixture();
		expect(
			await run({ key: "theme", value: "light" }, "settings.set"),
		).toMatchObject({ ok: true, settings: { key: "theme", value: "light" } });
		expect(await run({ key: "theme" }, "settings.get")).toMatchObject({
			ok: true,
			settings: { value: "light" },
		});
		expect(dependencies.claim.mock.invocationCallOrder[0]).toBeLessThan(
			dependencies.setPrefs.mock.invocationCallOrder[0],
		);
	});
});
