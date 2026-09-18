import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";
import { normalizeQuickCommands } from "@/lib/workspace/pane/quickCommands";
import { agentSpawnInteractionPreference } from "@/lib/workspace/pane/interfaceMode";
import { planUiPrefsUpdate, readUiPrefsSetting } from "./cliSettings";

interface SettingsDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(reqId: string, result: unknown, action: string): Promise<unknown>;
	getPrefs(): UiPrefs;
	setPrefs(patch: Partial<UiPrefs>): void;
}

function settingsResult(
	action: string,
	params: Record<string, unknown>,
	dependencies: SettingsDependencies,
): unknown {
	const prefs = dependencies.getPrefs() ?? DEFAULT_UI_PREFS;
	if (action === "agent.launch-preference") {
		return { ok: true, schemaVersion: 1, interactionPreference: agentSpawnInteractionPreference(prefs) ?? null };
	}
	if (action === "quick-commands") {
		const commands = prefs.quickCommands ?? [];
		if (params.operation === "list") return { ok: true, commands };
		if (params.operation === "put") {
			const [command] = normalizeQuickCommands([params.command]);
			if (!command)
				throw new Error(
					"Provide a command ID, a label up to 80 characters, text up to 16,000 characters without terminal controls, and explicit appendEnter.",
				);
			dependencies.setPrefs({
				quickCommands: commands.some((item) => item.id === command.id)
					? commands.map((item) => (item.id === command.id ? command : item))
					: [...commands, command],
			});
			return { ok: true, command };
		}
		if (
			params.operation === "remove" &&
			typeof params.id === "string" &&
			params.id.length > 0
		) {
			const remaining = commands.filter((item) => item.id !== params.id);
			if (remaining.length !== commands.length)
				dependencies.setPrefs({ quickCommands: remaining });
			return {
				ok: true,
				id: params.id,
				removed: remaining.length !== commands.length,
			};
		}
		throw new Error(
			"Quick Commands require list, put, or remove with an exact ID.",
		);
	}
	const key = typeof params.key === "string" ? params.key : undefined;
	if (action === "settings.set") {
		if (!key) throw new Error("settings.set requires a key");
		const raw =
			typeof params.value === "string"
				? params.value
				: JSON.stringify(params.value);
		const plan = planUiPrefsUpdate(key, raw);
		if (!plan.ok) throw new Error(plan.error);
		dependencies.setPrefs(plan.value);
	}
	const read = readUiPrefsSetting(
		dependencies.getPrefs() ?? DEFAULT_UI_PREFS,
		key,
	);
	if (!read.ok) throw new Error(read.error);
	return { ok: true, settings: read.value };
}

/** Claims one native request before changing the same preferences the UI owns. */
export async function dispatchCliSettingsRequest(
	request: { reqId: string; action: string; params: Record<string, unknown> },
	dependencies: SettingsDependencies,
): Promise<boolean> {
	if (
		!["settings.get", "settings.set", "quick-commands", "agent.launch-preference"].includes(request.action)
	)
		return false;
	if (!(await dependencies.claim(request.reqId))) return true;
	let result: unknown;
	try {
		result = settingsResult(request.action, request.params, dependencies);
	} catch (error) {
		result = {
			ok: false,
			error: {
				code: "invalid_request",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	await dependencies.complete(request.reqId, result, request.action);
	return true;
}
