import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedRebootRecoveryAssessment } from "@/lib/sessions/managed/managedRebootRecovery";
import {
	beginRestoreAll,
	dismissRestoreAll,
	finishRestoreAll,
	getRestoreAllState,
	publishRestoreAllOffer,
	resetRestoreAllForTest,
	restoreAllOffer,
	subscribeRestoreAll,
} from "@/lib/sessions/managed/managedRestoreAllOffer";
import { agentFixture } from "@/test/agentFixtures";

const restorable = (
	identity: string,
	desktopId: string,
	agentId = identity,
): ManagedRebootRecoveryAssessment => ({
	outcome: "restorable",
	candidate: {
		identity,
		agentId,
		desktopId,
		panelId: `agent:${agentId}`,
		conversationId: `conversation-${agentId}`,
	},
});

const entry = (identity: string) => ({
	identity,
	agentId: identity,
	name: identity,
});

beforeEach(resetRestoreAllForTest);

describe("restore-all offer", () => {
	it("offers only background Spaces and lists every agent it can't restore", () => {
		expect(
			restoreAllOffer(
				[
					restorable("on-screen", "visible"),
					restorable("background", "hidden"),
					{
						outcome: "skipped",
						identity: "no-conversation",
						agentId: "agent-3",
						reason: "no_conversation_id",
					},
				],
				new Set(["visible"]),
				[agentFixture({ id: "agent-3", name: "  Reviewer  " })],
			),
		).toEqual({
			restorable: [entry("background")],
			skipped: [
				{
					identity: "no-conversation",
					agentId: "agent-3",
					name: "Reviewer",
					reason: "no_conversation_id",
				},
			],
		});
	});

	it("stays quiet with nothing to restore, and does not offer an answered set again", () => {
		const listener = vi.fn();
		subscribeRestoreAll(listener);
		publishRestoreAllOffer({
			restorable: [],
			skipped: [{ ...entry("old"), reason: "pane_missing" }],
		});
		expect(getRestoreAllState()).toEqual({ phase: "idle" });
		expect(listener).not.toHaveBeenCalled();

		const offer = { restorable: [entry("a"), entry("b")], skipped: [] };
		publishRestoreAllOffer(offer);
		publishRestoreAllOffer({ ...offer, restorable: [...offer.restorable] });
		expect(listener).toHaveBeenCalledOnce();
		expect(getRestoreAllState()).toEqual({ phase: "offer", ...offer });

		dismissRestoreAll();
		publishRestoreAllOffer(offer);
		expect(getRestoreAllState()).toEqual({ phase: "idle" });

		const next = { restorable: [entry("a"), entry("c")], skipped: [] };
		publishRestoreAllOffer(next);
		expect(getRestoreAllState()).toEqual({ phase: "offer", ...next });
	});

	it("keeps a run and its report until the report is closed", () => {
		publishRestoreAllOffer({ restorable: [entry("a")], skipped: [] });
		expect(beginRestoreAll()).toBe(true);
		expect(beginRestoreAll()).toBe(false);
		publishRestoreAllOffer({ restorable: [entry("z")], skipped: [] });
		expect(getRestoreAllState()).toMatchObject({ phase: "restoring" });

		finishRestoreAll({
			restored: [entry("a")],
			skipped: [],
			failed: [entry("b")],
		});
		publishRestoreAllOffer({ restorable: [entry("b")], skipped: [] });
		expect(getRestoreAllState()).toMatchObject({ phase: "report" });

		dismissRestoreAll();
		publishRestoreAllOffer({ restorable: [entry("b")], skipped: [] });
		expect(getRestoreAllState()).toEqual({ phase: "idle" });
	});

	it("offers again after a run that could not read the agents' state", () => {
		const offer = { restorable: [entry("a")], skipped: [] };
		publishRestoreAllOffer(offer);
		beginRestoreAll();
		finishRestoreAll({
			restored: [],
			skipped: [],
			failed: [],
			unavailable: true,
		});
		dismissRestoreAll();
		publishRestoreAllOffer(offer);
		expect(getRestoreAllState()).toEqual({ phase: "offer", ...offer });
	});
});
