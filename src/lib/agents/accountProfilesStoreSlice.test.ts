import { describe, expect, it } from "vitest";
import { ProviderCredentialUnsupportedError } from "@/lib/agents/providerCredentials";
import { createAccountProfilesStoreSlice } from "./accountProfilesStoreSlice";

/** Minimal host harness — applies updater patches the way zustand's set does. */
function harness() {
	const slice = createAccountProfilesStoreSlice(
		(updater) => {
			const next = updater(host.state);
			if (next === host.state) return;
			host.state = { ...host.state, ...next };
		},
		() => host.state,
	);
	const host = {
		state: slice,
	};
	return host;
}

describe("accountProfilesStoreSlice", () => {
	it("계정 프로필 미지원 provider의 등록·활성화는 던진다", () => {
		const host = harness();
		expect(() =>
			host.state.addAccount({ provider: "gemini", name: "x", dir: "/d" }),
		).toThrow(ProviderCredentialUnsupportedError);
		expect(() => host.state.setActiveAccount("gemini", "acc-1")).toThrow(
			ProviderCredentialUnsupportedError,
		);
		expect(host.state.accounts).toEqual([]);
	});

	it("removeAccount는 그 계정을 가리키던 활성 지정을 함께 거둔다", () => {
		const host = harness();
		const acc = host.state.addAccount({
			provider: "claude",
			name: "work",
			dir: "/d",
		});
		host.state.setActiveAccount("claude", acc.id);
		expect(host.state.activeAccounts.claude).toBe(acc.id);
		host.state.removeAccount(acc.id);
		expect(host.state.accounts).toEqual([]);
		expect("claude" in host.state.activeAccounts).toBe(false);
	});

});
