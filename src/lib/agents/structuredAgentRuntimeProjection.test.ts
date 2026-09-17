import { describe, expect, it, vi } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { applyStructuredAgentProjection } from "./structuredAgentRuntimeProjection";

const runtime = (
	terminalEpoch: string,
	revision = "1",
): HmuxAgentRuntimeState => ({
	terminalEpoch,
	revision,
	observedThroughOutputSeq: "0",
	lifecycle: "running",
	activity: "working",
	attention: "none",
	source: "provider_event",
	turnCompletedCount: "0",
});

describe("applyStructuredAgentRuntimeProjection", () => {
	it("commits agent and shell identity through the same attachment fence", () => {
		const commit = vi.fn();
		const attachment = {
			sessionId: "session-a",
			terminalEpoch: "terminal-a",
			attachmentToken: "token-a",
		};

		for (const agent of ["codex", null] as const) {
			expect(
				applyStructuredAgentProjection({
					projection: {
						terminalEpoch: "terminal-a",
						observedThroughOutputSeq: "1",
						agent,
						source: "process_inspection",
					},
					attachment,
					currentAttachmentToken: "token-a",
					commit: (sessionId, identity) => commit(sessionId, identity.agent),
				}),
			).toBe("applied");
		}
		expect(commit.mock.calls).toEqual([
			["session-a", "codex"],
			["session-a", null],
		]);
	});

	it("commits to the exact attached session and epoch", () => {
		const commit = vi.fn();
		const state = runtime("terminal-a");

		expect(
			applyStructuredAgentProjection({
				projection: state,
				attachment: {
					sessionId: "session-a",
					terminalEpoch: "terminal-a",
					attachmentToken: "token-a",
				},
				currentAttachmentToken: "token-a",
				commit,
			}),
		).toBe("applied");
		expect(commit).toHaveBeenCalledWith("session-a", state);
	});

	it("rejects an epoch mismatch and a retired attachment without mutation", () => {
		const commit = vi.fn();
		const attachment = {
			sessionId: "session-a",
			terminalEpoch: "terminal-new",
			attachmentToken: "token-old",
		};

		expect(
			applyStructuredAgentProjection({
				projection: runtime("terminal-old"),
				attachment,
				currentAttachmentToken: "token-old",
				commit,
			}),
		).toBe("epoch_mismatch");
		expect(
			applyStructuredAgentProjection({
				projection: runtime("terminal-new", "99"),
				attachment,
				currentAttachmentToken: "token-new",
				commit,
			}),
		).toBe("stale_attachment");
		expect(commit).not.toHaveBeenCalled();
	});
});
