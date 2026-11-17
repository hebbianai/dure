import type { ObservedProviderCommandV1 } from "@/lib/agents/chat/observedRuntimeFacts";
import { t } from "@/lib/i18n";
import { parseSlashCommandDraft } from "../../../../cli/lib/contracts/slash-command.mjs";

/** Dure-level chat commands, each mapped to an existing pane control. */
export type DureChatCommandId = "clear" | "model";

export type ChatSlashCommand =
	| {
			readonly kind: "dure";
			readonly id: DureChatCommandId;
			readonly name: string;
			readonly description: string;
			readonly argumentHint: null;
			readonly aliases: readonly string[];
	  }
	| {
			readonly kind: "provider";
			readonly name: string;
			readonly description: string | null;
			readonly argumentHint: string | null;
			readonly aliases: readonly string[];
	  };

export type DureChatCommandAvailability = Readonly<
	Record<DureChatCommandId, boolean>
>;

const DURE_COMMANDS: readonly {
	id: DureChatCommandId;
	description: () => string;
}[] = [
	{ id: "clear", description: () => t("agents.chat.commandClear") },
	{ id: "model", description: () => t("agents.chat.commandModel") },
];

/** Every command the composer can run in this session. Dure's own commands
 * shadow a provider command of the same name: a provider `/clear` would reset
 * its session underneath Dure's conversation identity, and `/model` belongs to
 * the pane's launch selection, not the provider's private state. */
export function chatSlashCommands(
	provider: readonly ObservedProviderCommandV1[] | null,
	available: DureChatCommandAvailability,
): readonly ChatSlashCommand[] {
	const dure = DURE_COMMANDS.filter((command) => available[command.id]).map(
		(command): ChatSlashCommand => ({
			kind: "dure",
			id: command.id,
			name: command.id,
			description: command.description(),
			argumentHint: null,
			aliases: [],
		}),
	);
	const reserved = new Set<string>(DURE_COMMANDS.map(({ id }) => id));
	const providerCommands = (provider ?? []).flatMap(
		(command): ChatSlashCommand[] => {
			const name = command.name.toLowerCase();
			if (reserved.has(name)) return [];
			reserved.add(name);
			return [
				{
					kind: "provider",
					name: command.name,
					description: command.description,
					argumentHint: command.argumentHint,
					aliases: command.aliases.filter(
						(alias) => !reserved.has(alias.toLowerCase()),
					),
				},
			];
		},
	);
	return [...dure, ...providerCommands];
}

export { parseSlashCommandDraft };

/** The partial name typed so far, while the caret is still in the first
 * token. Null once arguments start or when the draft is not a command. */
export function slashCommandQuery(draft: string): string | null {
	if (!/^\/\S*$/u.test(draft)) return null;
	const parsed = parseSlashCommandDraft(draft);
	return parsed ? parsed.name : null;
}

const MAX_MATCHES = 50;

/** Prefix matches (name, then alias) rank before substring matches; the
 * provider's own order is kept within each group. */
export function matchSlashCommands(
	commands: readonly ChatSlashCommand[],
	query: string,
): readonly ChatSlashCommand[] {
	const needle = query.toLowerCase();
	if (!needle) return commands.slice(0, MAX_MATCHES);
	const prefix: ChatSlashCommand[] = [];
	const alias: ChatSlashCommand[] = [];
	const substring: ChatSlashCommand[] = [];
	for (const command of commands) {
		const name = command.name.toLowerCase();
		if (name.startsWith(needle)) prefix.push(command);
		else if (command.aliases.some((value) => value.toLowerCase().startsWith(needle))) {
			alias.push(command);
		} else if (name.includes(needle)) substring.push(command);
	}
	return [...prefix, ...alias, ...substring].slice(0, MAX_MATCHES);
}

export type SlashCommandResolution =
	| { readonly kind: "text" }
	| {
			readonly kind: "command";
			readonly command: ChatSlashCommand;
			readonly args: string;
	  }
	| { readonly kind: "unknown"; readonly name: string };

/** What a submitted draft asks for. An unknown `/name` is never sent as a
 * prompt: the provider would read it as plain text and the user would not
 * learn the command did not run. */
export function resolveSlashCommand(
	draft: string,
	commands: readonly ChatSlashCommand[],
): SlashCommandResolution {
	const parsed = parseSlashCommandDraft(draft);
	if (!parsed) return { kind: "text" };
	const name = parsed.name.toLowerCase();
	const command = commands.find(
		(candidate) =>
			candidate.name.toLowerCase() === name ||
			candidate.aliases.some((alias) => alias.toLowerCase() === name),
	);
	return command
		? { kind: "command", command, args: parsed.args }
		: { kind: "unknown", name: parsed.name };
}
