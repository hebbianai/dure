import { describe, expect, it } from "vitest";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { observedProviderCommands } from "@/lib/agents/chat/observedRuntimeFacts";
import {
	chatSlashCommands,
	matchSlashCommands,
	parseSlashCommandDraft,
	resolveSlashCommand,
	slashCommandQuery,
} from "@/lib/agents/chat/slashCommands";

function evidence(sequence: number, value: unknown): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId: null,
			clientMessageId: null,
			providerMessageId: null,
			createdAtMs: sequence,
			body: {
				type: "provider_evidence",
				namespace: "provider.claude",
				kind: "provider_commands",
				value,
			},
		},
	} as AgentTimelineRowV1;
}

const provider = [
	{ name: "compact", description: "Summarize", argumentHint: "<focus>", aliases: [] },
	{ name: "clear", description: "Provider clear", argumentHint: null, aliases: ["reset"] },
	{ name: "usage", description: "Usage", argumentHint: null, aliases: ["cost", "model"] },
	{ name: "review", description: null, argumentHint: null, aliases: [] },
];

describe("observed provider commands", () => {
	it("reads the newest provider report and drops malformed entries", () => {
		expect(observedProviderCommands({ rows: [] })).toBeNull();
		const rows = [
			evidence(1, { commands: [{ name: "old" }] }),
			evidence(2, {
				commands: [
					{ name: "compact", description: "Summarize", argumentHint: "<focus>" },
					{ name: "bad name" },
					{ name: "usage", aliases: ["cost", "bad alias", 3] },
					"compact",
				],
			}),
		];
		expect(observedProviderCommands({ rows })).toEqual([
			{ name: "compact", description: "Summarize", argumentHint: "<focus>", aliases: [] },
			{ name: "usage", description: null, argumentHint: null, aliases: ["cost"] },
		]);
	});
});

describe("chat slash commands", () => {
	it("lists Dure commands first and lets them shadow provider names and aliases", () => {
		const commands = chatSlashCommands(provider, { clear: true, model: true });
		expect(commands.map((command) => [command.kind, command.name])).toEqual([
			["dure", "clear"],
			["dure", "model"],
			["provider", "compact"],
			["provider", "usage"],
			["provider", "review"],
		]);
		expect(commands.find((command) => command.name === "usage")?.aliases).toEqual([
			"cost",
		]);
	});

	it("omits a Dure command the pane cannot run", () => {
		const commands = chatSlashCommands(null, { clear: false, model: true });
		expect(commands.map((command) => command.name)).toEqual(["model"]);
	});

	it("parses only a leading /name token as a command attempt", () => {
		expect(parseSlashCommandDraft("/compact keep the API notes")).toEqual({
			name: "compact",
			args: "keep the API notes",
		});
		expect(parseSlashCommandDraft("/")).toEqual({ name: "", args: "" });
		expect(parseSlashCommandDraft("/Users/me/notes.md what is this?")).toBeNull();
		expect(parseSlashCommandDraft("// not a command")).toBeNull();
		expect(parseSlashCommandDraft("please /compact")).toBeNull();
		expect(slashCommandQuery("/com")).toBe("com");
		expect(slashCommandQuery("/compact now")).toBeNull();
		expect(slashCommandQuery("hello")).toBeNull();
	});

	it("ranks prefix matches before alias and substring matches", () => {
		const commands = chatSlashCommands(provider, { clear: true, model: true });
		expect(matchSlashCommands(commands, "c").map(({ name }) => name)).toEqual([
			"clear",
			"compact",
			"usage",
		]);
		expect(matchSlashCommands(commands, "view").map(({ name }) => name)).toEqual([
			"review",
		]);
		expect(matchSlashCommands(commands, "")).toHaveLength(commands.length);
	});

	it("resolves names and aliases, and reports an unknown command instead of sending it", () => {
		const commands = chatSlashCommands(provider, { clear: true, model: true });
		expect(resolveSlashCommand("/model", commands)).toMatchObject({
			kind: "command",
			command: { kind: "dure", id: "model" },
		});
		expect(resolveSlashCommand("/COST", commands)).toMatchObject({
			kind: "command",
			command: { kind: "provider", name: "usage" },
		});
		expect(resolveSlashCommand("/compact focus on tests", commands)).toMatchObject({
			kind: "command",
			args: "focus on tests",
		});
		expect(resolveSlashCommand("/nope", commands)).toEqual({
			kind: "unknown",
			name: "nope",
		});
		expect(resolveSlashCommand("plain text", commands)).toEqual({ kind: "text" });
	});
});
