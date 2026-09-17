import { describe, expect, it } from "vitest";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
	isDureProviderConversationRefV1,
	isDureWireTokenV1,
} from "@/lib/ipc/dureProtocolIdentity";

describe("Dure protocol identity", () => {
	it("shares the exact domain identifier boundary", () => {
		expect(isDureDomainIdV1("spawn-operation:1")).toBe(true);
		expect(isDureDomainIdV1(`a${"b".repeat(159)}`)).toBe(true);
		expect(isDureDomainIdV1(`a${"b".repeat(160)}`)).toBe(false);
		expect(isDureDomainIdV1("operation id")).toBe(false);
	});

	it("keeps backend profiles stricter than opaque wire tokens", () => {
		expect(isDureBackendProfileIdV1("ssh-team.primary")).toBe(true);
		expect(isDureBackendProfileIdV1("SSH-Team")).toBe(false);
		expect(isDureWireTokenV1(`a${"b".repeat(511)}`)).toBe(true);
		expect(isDureWireTokenV1(`a${"b".repeat(512)}`)).toBe(false);
	});

	it("uses the durable 160-byte provider conversation token boundary", () => {
		expect(isDureProviderConversationRefV1("threads/2026-08-30:turn_1")).toBe(
			true,
		);
		expect(isDureProviderConversationRefV1(`/${"a".repeat(159)}`)).toBe(true);
		expect(isDureProviderConversationRefV1(`/${"a".repeat(160)}`)).toBe(false);
		expect(isDureProviderConversationRefV1("conversation+alias")).toBe(false);
	});
});
