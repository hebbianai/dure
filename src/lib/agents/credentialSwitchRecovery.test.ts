import { describe, expect, it, vi } from "vitest";
import {
	credentialProfileRecovery,
	credentialSwitchErrorCode,
	runCredentialSwitchWithFeedback,
} from "@/lib/agents/credentialSwitchRecovery";
import type { AccountProfile } from "@/types";

const account: AccountProfile = {
	id: "account-legacy",
	provider: "claude",
	name: "work",
	dir: "/profiles/claude-work",
};

describe("credential switch recovery", () => {
	it("recognizes typed overlay conflicts without depending on an exact message", () => {
		expect(
			credentialSwitchErrorCode(
				"credential_overlay_wrong_type: shared directory entry must be a symlink",
			),
		).toBe("credential_overlay_wrong_type");
		expect(
			credentialSwitchErrorCode({
				code: "credential_file_untrusted",
				message: "do not share this credential",
			}),
		).toBe("credential_file_untrusted");
	});

	it("builds a replacement profile recovery without changing the legacy path", () => {
		expect(
			credentialProfileRecovery(
				new Error(
					"credential_overlay_wrong_target: shared state points elsewhere",
				),
				account,
			),
		).toMatchObject({
			kind: "create_replacement_profile",
			accountId: "account-legacy",
			profileDirectory: "/profiles/claude-work",
			suggestedName: "work-new",
			errorCode: "credential_overlay_wrong_target",
		});
	});

	it("routes a rejected manual switch to recovery instead of swallowing it", async () => {
		const onRecovery = vi.fn();
		const onFailure = vi.fn();

		await expect(
			runCredentialSwitchWithFeedback({
				execute: () =>
					Promise.reject(
						"credential_overlay_wrong_type: legacy directory blocks overlay",
					),
				account,
				onRecovery,
				onFailure,
			}),
		).resolves.toBe("recovery");
		expect(onRecovery).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: account.id }),
		);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("surfaces unrelated failures through the ordinary error path", async () => {
		const onRecovery = vi.fn();
		const onFailure = vi.fn();
		const error = new Error("provider unavailable");

		await expect(
			runCredentialSwitchWithFeedback({
				execute: () => Promise.reject(error),
				account,
				onRecovery,
				onFailure,
			}),
		).resolves.toBe("failed");
		expect(onRecovery).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledWith(error);
	});
});
