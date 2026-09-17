import { describe, expect, it } from "vitest";
import {
	isManagedRehostTargetReceiptV1,
	isManagedStopReceiptV2,
} from "@/lib/hmux/managed/managedRehostTargetReceipt";

describe("managed rehost target receipt", () => {
	it("accepts the journal-selected permission mode as exact replacement evidence", () => {
		expect(
			isManagedRehostTargetReceiptV1({
				idempotencyKey: "replacement-1",
				sessionId: "session-new",
				workspaceId: "workspace-1",
				providerId: "codex",
				permissionMode: "bypass_approvals",
				runnerPrincipal: "principal-1",
				runnerInstance: "runner-1",
				channelEpoch: "2",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
				diagnostics: { adapter: "local" },
			}),
		).toBe(true);
	});
});

describe("managed stop receipt", () => {
	const expected = {
		sessionId: "session/root",
		workspaceId: "workspace/root",
	};
	const receipt = () => ({
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "stop/root",
		sessionId: expected.sessionId,
		workspaceId: expected.workspaceId,
		runnerPrincipal: "principal/root 한글",
		runnerInstance: "runner/root",
		channelEpoch: 7,
		hostInstanceId: "host/root",
		terminalEpoch: "terminal/root",
		outcome: "stopped",
		exitReason: "managed provider stop",
	});

	it("accepts identifiers allowed by the Rust contract", () => {
		expect(isManagedStopReceiptV2(receipt(), expected)).toBe(true);
	});

	it("rejects control characters at the contract boundary", () => {
		expect(
			isManagedStopReceiptV2(
				{ ...receipt(), runnerPrincipal: "principal\nchanged" },
				expected,
			),
		).toBe(false);
		expect(
			isManagedStopReceiptV2(
				{ ...receipt(), exitReason: "stopped\nchanged" },
				expected,
			),
		).toBe(false);
	});
});
