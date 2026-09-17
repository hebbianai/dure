import { describe, expect, it } from "vitest";
import type { SshConfigScan, SshHostConfig } from "@/types";
import { remoteShellHostCandidate } from "./remoteHmuxShellRegistration";

const config: SshConfigScan = {
	files: [],
	defaultUser: "must-not-infer",
	aliasInspection: { kind: "complete", aliases: [] },
};
const destination = { host: "192.0.2.1", user: "qa", port: 2222 };
const saved: SshHostConfig = {
	id: "saved",
	name: "Custom",
	...destination,
	auth: "auto",
};

describe("remote shell registration candidate", () => {
	it("does not treat an incomplete or legacy SSH scan as proof of an unknown address", () => {
		for (const aliasInspection of [undefined, { kind: "partial" } as const]) {
			expect(
				remoteShellHostCandidate([], destination, {
					...config,
					aliasInspection,
				}),
			).toBeUndefined();
		}
	});
	it("derives only non-secret auto-auth fields from an explicit unknown destination", () => {
		expect(remoteShellHostCandidate([], destination, config)).toEqual({
			name: "qa@192.0.2.1:2222",
			...destination,
			auth: "auto",
		});
	});
	it.each([
		{ host: "192.0.2.1", port: 2222 },
		{ host: "192.0.2.1", user: "qa" },
		{ ...destination, host: "alias" },
		{ ...destination, user: "user:password" },
		{ ...destination, user: "-option" },
		{ ...destination, port: 0 },
		{ ...destination, port: 65_536 },
	])("does not infer or register ambiguous inputs: %j", (input) => {
		expect(remoteShellHostCandidate([], input, config)).toBeUndefined();
	});
	it("does not register exact or duplicated saved matches", () => {
		expect(
			remoteShellHostCandidate([saved], destination, config),
		).toBeUndefined();
		expect(
			remoteShellHostCandidate(
				[saved, { ...saved, id: "duplicate" }],
				destination,
				config,
			),
		).toBeUndefined();
	});
	it("does not turn a saved display name or SSH config alias into a network host", () => {
		const input = { ...destination, host: "alias.example" };
		expect(
			remoteShellHostCandidate([{ ...saved, name: input.host }], input, config),
		).toBeUndefined();
		expect(
			remoteShellHostCandidate([], input, {
				...config,
				aliasInspection: { kind: "complete", aliases: ["ALIAS.EXAMPLE"] },
			}),
		).toBeUndefined();
	});
	it("recognizes equivalent saved DNS and IPv6 addresses before offering registration", () => {
		for (const [stored, input] of [
			["HOST.example", "host.example."],
			["2001:db8::1", "2001:0db8:0:0:0:0:0:1"],
		]) {
			expect(
				remoteShellHostCandidate(
					[{ ...saved, host: stored }],
					{ ...destination, host: input },
					config,
				),
			).toBeUndefined();
		}
	});
});
