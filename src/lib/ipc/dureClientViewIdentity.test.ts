import { describe, expect, it, vi } from "vitest";
import {
	parseDureClientViewLocalIdentity,
	readDureClientViewLocalIdentity,
} from "@/lib/ipc/dureClientViewIdentity";

const identity = {
	schemaVersion: 1,
	namespace: {
		tenantId: "personal",
		userId: "owner",
		clientId: "client-1234",
	},
	clientInstanceId: "instance-5678",
};

describe("Dure client view local identity", () => {
	it("reads the channel-scoped durable identity without app-server input", async () => {
		const invokeCommand = vi.fn().mockResolvedValue(identity);
		await expect(
			readDureClientViewLocalIdentity(invokeCommand),
		).resolves.toEqual(identity);
		expect(invokeCommand).toHaveBeenCalledWith(
			"dure_client_view_local_identity",
		);
	});

	it("rejects malformed and unbounded identifiers", () => {
		expect(parseDureClientViewLocalIdentity(identity)).toEqual(identity);
		expect(
			parseDureClientViewLocalIdentity({
				...identity,
				namespace: { ...identity.namespace, clientId: "client." },
			}),
		).toMatchObject({ namespace: { clientId: "client." } });
		expect(
			parseDureClientViewLocalIdentity({
				...identity,
				namespace: { ...identity.namespace, clientId: "../other-client" },
			}),
		).toBeNull();
		expect(
			parseDureClientViewLocalIdentity({
				...identity,
				clientInstanceId: `instance-${"x".repeat(160)}`,
			}),
		).toBeNull();
	});
});
