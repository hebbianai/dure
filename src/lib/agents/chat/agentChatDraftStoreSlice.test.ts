// @vitest-environment jsdom

import { beforeEach, expect, it } from "vitest";
import {
	appendAgentChatDraft,
	prepareAgentChatDraftTarget,
} from "@/lib/agents/chat/agentChatDraftInput";
import { agentChatDraftKey } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-draft",
};
const agent = () =>
	managedAgentFixture({
		id: "chat-draft",
		runtimeBinding: undefined,
		interactionProfile: profile,
	});
const image = { fileName: "unsent.png", dataB64: "dW5zZW50LWltYWdl" };

beforeEach(async () => {
	useStore.setState({
		agents: [agent()],
		projects: [
			{
				id: agent().projectId,
				name: "Draft",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		chatDrafts: {}, chatDraftMoves: {}, chatDraftMoveReceipts: {}, chatDraftEpochs: {},
		layouts: {},
	});
	await durableAppStorage.flush();
});

async function commitAgents(agents: Agent[]) {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) throw new Error("fixture has no durable state");
		return {
			value: { ...current, state: { ...current.state, agents } },
			result: undefined,
		};
	});
	await settleDurableAppState();
}

it("keeps the draft across an execution registration replacement in the same interaction", async () => {
	const target = prepareAgentChatDraftTarget(agent());
	appendAgentChatDraft(target, "Unsubmitted draft", [image]);
	const original = useStore.getState().chatDrafts;
	await commitAgents([
		{ ...agent(), sessionId: "replacement-runtime-session" },
	]);
	expect(useStore.getState().agents[0].sessionId).toBe(
		"replacement-runtime-session",
	);
	expect(useStore.getState().chatDrafts).toEqual(original);
	expect(
		useStore.getState().chatDrafts[agent().id][
			agentChatDraftKey(target.identity)
		],
	).toEqual({ text: "Unsubmitted draft", attachments: [image] });
});

it("removes only the departed agent's unsent bytes when a durable deletion arrives", async () => {
	const other = {
		...agent(),
		id: "other-chat",
		sessionId: "other-runtime",
		interactionProfile: {
			...profile,
			interactionSessionId: "other-interaction",
		},
	};
	useStore.setState({ agents: [agent(), other] });
	await durableAppStorage.flush();
	appendAgentChatDraft(
		prepareAgentChatDraftTarget(agent()),
		"Departing draft",
		[image],
	);
	appendAgentChatDraft(prepareAgentChatDraftTarget(other), "Keep other draft", [
		image,
	]);
	const retained = useStore.getState().chatDrafts[other.id];
	await commitAgents([other]);
	expect(useStore.getState().chatDrafts).toEqual({ [other.id]: retained });
});

it("keeps unsent text and image bytes out of durable storage", async () => {
	appendAgentChatDraft(
		prepareAgentChatDraftTarget(agent()),
		"Volatile secret draft",
		[image],
	);
	await durableAppStorage.flush();
	const stored = localStorage.getItem(DURABLE_APP_STORE_NAME);
	expect(stored).not.toBeNull();
	expect(stored).not.toContain("chatDrafts");
	expect(stored).not.toContain("Volatile secret draft");
	expect(stored).not.toContain(image.dataB64);
});

it("isolates input by agent, backend profile and interaction session", () => {
	const first = prepareAgentChatDraftTarget(agent());
	appendAgentChatDraft(first, "Original", [image]);
	const replacements = [
		{ ...agent(), id: "other-agent" },
		{
			...agent(),
			interactionProfile: { ...profile, backendProfileId: "other-backend" },
		},
		{
			...agent(),
			interactionProfile: {
				...profile,
				interactionSessionId: "other-interaction",
			},
		},
	];
	for (const replacement of replacements) {
		useStore.setState({ agents: [replacement] });
		const target = prepareAgentChatDraftTarget(replacement);
		appendAgentChatDraft(target, "Separate");
		expect(
			useStore.getState().chatDrafts[replacement.id][
				agentChatDraftKey(target.identity)
			],
		).toEqual({ text: "Separate", attachments: [] });
	}
	expect(
		useStore.getState().chatDrafts[first.identity.agentId][
			agentChatDraftKey(first.identity)
		],
	).toEqual({ text: "Original", attachments: [image] });
});


it("keeps staged move images out of durable storage and removes them when their Agent is deleted", async () => {
	const target = prepareAgentChatDraftTarget(agent());
	const transfer = { id: "staged-private-move", digest: `sha256:${"a".repeat(64)}`, target,
		source: { schemaVersion: 1 as const, desktopId: "source", dockviewId: "dock-1", paneId: `agent:${agent().id}`, windowLabel: "main", windowGeneration: "boot-1" },
		destination: { schemaVersion: 1 as const, desktopId: "target", dockviewId: "dock-2", windowLabel: "win-popout-target", windowGeneration: "boot-2" },
	};
	useStore.getState().applyChatDraftMove({ action: "stage", packet: { transfer,
		drafts: { [agentChatDraftKey(target.identity)]: { text: "Private staged draft", attachments: [image] } } } });
	await durableAppStorage.flush();
	const persisted = await durableAppStorage.getItem(DURABLE_APP_STORE_NAME);
	expect(JSON.stringify(persisted)).not.toContain("Private staged draft");
	expect(JSON.stringify(persisted)).not.toContain(image.dataB64);
	expect(JSON.stringify(persisted)).not.toContain("chatDraftMoves");
	await commitAgents([]);
	expect(useStore.getState().chatDraftMoves).toEqual({});
});
