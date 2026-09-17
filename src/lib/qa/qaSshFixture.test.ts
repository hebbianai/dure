import { describe, expect, it } from "vitest";
import { qaSshFixture } from "@/lib/qa/qaSshFixture";

function encodedFixture(overrides: Record<string, unknown> = {}): string {
	return btoa(
		JSON.stringify({
			name: "receipt-loss",
			host: "remote.internal",
			user: "dure",
			port: 22,
			auth: "key",
			keyPath: "/tmp/id_ed25519",
			expectedWorkspacePath: "/tmp/project",
			...overrides,
		}),
	)
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/u, "");
}

describe("QA SSH fixture", () => {
	it("parses each SSH consumer from its own directive", () => {
		const onboarding = encodedFixture({ name: "onboarding" });
		const project = encodedFixture();
		const flag = `onboardingssh=${onboarding}\nsshproject=${project}`;

		expect(qaSshFixture(flag, "onboardingssh")?.name).toBe("onboarding");
		expect(qaSshFixture(flag, "sshproject")).toEqual({
			name: "receipt-loss",
			host: "remote.internal",
			user: "dure",
			port: 22,
			keyPath: "/tmp/id_ed25519",
			expectedWorkspacePath: "/tmp/project",
		});
		expect(qaSshFixture("full", "sshproject")).toBeUndefined();
	});

	it("rejects a fixture outside the shared key-auth shape", () => {
		const flag = `sshproject=${encodedFixture({ auth: "auto" })}`;
		expect(() => qaSshFixture(flag, "sshproject")).toThrow(
			"outside the reviewed key-auth shape",
		);
	});
});
