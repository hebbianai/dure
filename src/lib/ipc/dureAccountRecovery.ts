import {
	parseRecoveryPolicy,
	parseRecoveryProfile,
	parseRecoveryWaits,
	type RecoveryAccount,
	type RecoveryPolicy,
	type RecoveryProfile,
	type RecoveryWait,
} from "@/lib/agents/accountRecoveryContract";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export interface RecoverySettingsSnapshot {
	providerId: string;
	policy: RecoveryPolicy | null;
	profiles: RecoveryProfile[];
	routeAuthority: DureBackendRouteAuthorityV1;
}

export function createAccountRecoveryClient(
	profileId: string,
	invokeCommand?: DureBackendInvoke,
) {
	const request = createDureBackendRequester({
		profileId,
		invokeCommand,
		invalidResponseCode: "provider_recovery_response_invalid",
		invalidResponseMessage: "ipc.dureRun.invalidResponse",
		backendChangedCode: "provider_recovery_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "provider_recovery_transport_failed",
		requestFailedMessage: "ipc.dureRun.requestFailed",
	});
	function invalid(): never {
		throw new DureBackendRequestError(
			"provider_recovery_response_invalid",
			t("ipc.dureRun.invalidResponse"),
			{ kind: "contract" },
		);
	}
	return {
		async get(
			providerId: string,
			routeAuthority?: DureBackendRouteAuthorityV1,
		): Promise<RecoverySettingsSnapshot> {
			const response = await request(
				"provider_recovery.get",
				{ schemaVersion: 1, providerId },
				routeAuthority
					? { kind: "exact", authority: routeAuthority }
					: { kind: "complete_selected_snapshot" },
			);
			const policy =
				response.result.policy === null
					? null
					: parseRecoveryPolicy(response.result.policy);
			if (
				policy === undefined ||
				(policy && policy.providerId !== providerId) ||
				!Array.isArray(response.result.profiles)
			)
				invalid();
			const profiles = response.result.profiles.map(parseRecoveryProfile);
			if (
				profiles.some(
					(profile) => !profile || profile.providerId !== providerId,
				)
			)
				invalid();
			return {
				providerId,
				policy,
				profiles: profiles as RecoveryProfile[],
				routeAuthority: response.routeAuthority,
			};
		},
		async put(
			body: {
				providerId: string;
				expectedRevision: number;
				idempotencyKey: string;
				enabled: boolean;
				accounts: RecoveryAccount[];
				continueAfterReset?: boolean;
			},
			routeAuthority: DureBackendRouteAuthorityV1,
		): Promise<RecoveryPolicy> {
			const { continueAfterReset, ...policyBody } = body;
			const response = await request(
				"provider_recovery.put",
				{
					schemaVersion: 1,
					...policyBody,
					// Sent only when on: a backend that predates the switch then
					// keeps accepting the policy, and turning it off is omission.
					...(continueAfterReset ? { continueAfterReset } : {}),
				},
				{ kind: "exact", authority: routeAuthority },
			);
			const policy = parseRecoveryPolicy(response.result.policy);
			if (
				!policy ||
				policy.providerId !== body.providerId ||
				policy.revision !== body.expectedRevision + 1
			)
				invalid();
			return policy;
		},
		/** Every Agent this backend continues on its own once its usage limit
		 * resets. A backend without the list fails with its capability. */
		async waits(): Promise<RecoveryWait[]> {
			const response = await request(
				"agent_recovery.waits",
				{ schemaVersion: 1 },
				{ kind: "complete_selected_snapshot" },
			);
			return parseRecoveryWaits(response.result.waits) ?? invalid();
		},
	};
}
