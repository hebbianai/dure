import { describe, expect, it } from "vitest";
import {
	isLegacyOrderedManagedCreateChainStopEventReceiptV1,
	isManagedCreateChainStopReceiptV1,
	isManagedCreateChainStopReceiptV2,
	type ManagedCreateChainStopReceiptV2,
	type ManagedCreateReconcileIdentityV1,
	managedCreateChainStopLegacyOrderedV1EventProjection,
	managedCreateChainStopLegacyV1Projection,
} from "./managedCreateChainStopReceipt";

const expectedRoot = {
	idempotencyKey: "create-root-1",
	sessionId: "session-root-1",
	workspaceId: "workspace-1",
};

const identity = (
	idempotencyKey: string,
	sessionId: string,
): ManagedCreateReconcileIdentityV1 => ({
	schema: "hmux-managed-create-reconcile-v1",
	schemaVersion: 1,
	idempotencyKey,
	sessionId,
	workspaceId: "workspace-1",
});

type CompleteReceipt = ManagedCreateChainStopReceiptV2 & {
	stopReceipt: NonNullable<ManagedCreateChainStopReceiptV2["stopReceipt"]>;
};

const receipt = (): CompleteReceipt => ({
	schema: "hmux-managed-create-chain-stop-v2",
	schemaVersion: 2,
	chain: [
		identity("create-root-1", "session-root-1"),
		identity("create-successor-1", "session-successor-1"),
	],
	stopReceipt: {
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "managed-create-stop-1",
		sessionId: "session-successor-1",
		workspaceId: "workspace-1",
		runnerPrincipal: "principal-1",
		runnerInstance: "runner-1",
		channelEpoch: 7,
		hostInstanceId: "host-1",
		terminalEpoch: "terminal-1",
		outcome: "stopped",
		exitReason: "managed_provider_stop",
	},
});

describe("managed create chain-stop receipt", () => {
	it("keeps the frozen v1 root/effective wire readable", () => {
		const value = receipt();
		expect(
			isManagedCreateChainStopReceiptV1(
				{
					schema: "hmux-managed-create-chain-stop-v1",
					schemaVersion: 1,
					root: value.chain[0],
					effective: value.chain[1],
					stopReceipt: value.stopReceipt,
				},
				expectedRoot,
			),
		).toBe(true);
	});

	it("keeps the previously shipped ordered v1 wire readable", () => {
		const value = receipt();
		expect(
			isLegacyOrderedManagedCreateChainStopEventReceiptV1(
				{
					schema: "hmux-managed-create-chain-stop-v1",
					schemaVersion: 1,
					chain: value.chain,
					stopReceipt: value.stopReceipt,
				},
				expectedRoot,
			),
		).toBe(true);
	});

	it("projects one v2 receipt into both frozen v1 generations", () => {
		const value = receipt();
		expect(
			managedCreateChainStopLegacyV1Projection(value, value.chain[0]),
		).toEqual({
			schema: "hmux-managed-create-chain-stop-v1",
			schemaVersion: 1,
			root: value.chain[0],
			effective: value.chain[1],
			stopReceipt: value.stopReceipt,
		});
		expect(managedCreateChainStopLegacyOrderedV1EventProjection(value)).toEqual(
			{
				schema: "hmux-managed-create-chain-stop-v1",
				schemaVersion: 1,
				chain: value.chain,
				stopReceipt: value.stopReceipt,
			},
		);
	});

	it("accepts the effective successor selected by the root ledger", () => {
		expect(isManagedCreateChainStopReceiptV2(receipt(), expectedRoot)).toBe(
			true,
		);
	});

	it("accepts an ancestor-complete chain when the request is an intermediate identity", () => {
		const value = receipt();
		value.chain.splice(
			1,
			0,
			identity("create-intermediate-1", "session-intermediate-1"),
		);
		expect(
			isManagedCreateChainStopReceiptV2(value, {
				idempotencyKey: "create-intermediate-1",
				sessionId: "session-intermediate-1",
				workspaceId: "workspace-1",
			}),
		).toBe(true);
	});

	it("accepts a durably closed chain that never completed a generation", () => {
		const value = receipt();
		const { stopReceipt: _stopReceipt, ...closed } = value;
		expect(isManagedCreateChainStopReceiptV2(closed, expectedRoot)).toBe(true);
	});

	it("rejects a changed root, workspace, or effective stop identity", () => {
		const changedRoot = {
			...receipt(),
			chain: [
				identity("other-root", "session-root-1"),
				identity("create-successor-1", "session-successor-1"),
			],
		};
		expect(isManagedCreateChainStopReceiptV2(changedRoot, expectedRoot)).toBe(
			false,
		);

		const changedWorkspace = receipt();
		changedWorkspace.chain[1] = {
			...changedWorkspace.chain[1],
			workspaceId: "workspace-other",
		};
		expect(
			isManagedCreateChainStopReceiptV2(changedWorkspace, expectedRoot),
		).toBe(false);

		const changedStop = receipt();
		changedStop.stopReceipt.sessionId = "session-other";
		expect(isManagedCreateChainStopReceiptV2(changedStop, expectedRoot)).toBe(
			false,
		);
	});

	it("accepts the full Rust identifier contract", () => {
		const value = receipt();
		value.chain[0] = {
			...value.chain[0],
			idempotencyKey: "create/root 한글",
			sessionId: "session/root",
		};
		value.stopReceipt.runnerPrincipal = "principal/root 한글";
		expect(
			isManagedCreateChainStopReceiptV2(value, {
				...expectedRoot,
				idempotencyKey: "create/root 한글",
				sessionId: "session/root",
			}),
		).toBe(true);
	});

	it("rejects empty, repeated, or control-character identities", () => {
		const empty = { ...receipt(), chain: [] };
		expect(isManagedCreateChainStopReceiptV2(empty, expectedRoot)).toBe(false);

		const repeated = receipt();
		repeated.chain[1] = repeated.chain[0];
		expect(isManagedCreateChainStopReceiptV2(repeated, expectedRoot)).toBe(
			false,
		);

		const controlled = receipt();
		controlled.chain[1].sessionId = "session\ninvalid";
		expect(isManagedCreateChainStopReceiptV2(controlled, expectedRoot)).toBe(
			false,
		);
	});

	it("rejects a chain that cannot fit the bounded broker receipt", () => {
		const { stopReceipt: _stopReceipt, ...value } = receipt();
		const closed = {
			...value,
			chain: Array.from({ length: 129 }, (_, index) =>
				identity(`create-${index}`, `session-${index}`),
			),
		};
		expect(isManagedCreateChainStopReceiptV2(closed)).toBe(false);
		expect(
			isLegacyOrderedManagedCreateChainStopEventReceiptV1({
				...closed,
				schema: "hmux-managed-create-chain-stop-v1",
				schemaVersion: 1,
			}),
		).toBe(false);
	});

	it("rejects unknown fields instead of silently changing the contract", () => {
		expect(
			isManagedCreateChainStopReceiptV2(
				{ ...receipt(), fallbackExactStop: true },
				expectedRoot,
			),
		).toBe(false);
	});
});
