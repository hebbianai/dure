import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord, hasOnlyKeys, nonNegativeInteger } from "@/lib/payloadGuards";

export interface RecoveryProfile {
	schemaVersion: 1;
	providerId: string;
	referenceId: string;
	credentialGeneration: string;
}
export interface RecoveryAccount {
	profile: RecoveryProfile;
	name: string;
}
export interface RecoveryPolicy {
	schemaVersion: 1;
	providerId: string;
	revision: number;
	enabled: boolean;
	accounts: RecoveryAccount[];
	activatedAtMs: number | null;
	updatedAtMs: number;
}
export interface RecoveryObservation {
	attemptId: string;
	failureItemId: string;
	target: RecoveryAccount | null;
	stopped:
		| { kind: "exhausted" | "superseded" }
		| { kind: "failed"; code: string }
		| null;
	turnState: "prepared" | "accepted" | "failed" | "uncertain" | null;
	createdAtMs: number;
}

export function parseRecoveryProfile(
	value: unknown,
): RecoveryProfile | undefined {
	const profile = asRecord(value);
	if (
		!profile ||
		!hasOnlyKeys(profile, [
			"schemaVersion",
			"providerId",
			"referenceId",
			"credentialGeneration",
		]) ||
		profile.schemaVersion !== 1 ||
		typeof profile.providerId !== "string" ||
		!isDureDomainIdV1(profile.referenceId) ||
		!isDureDomainIdV1(profile.credentialGeneration)
	)
		return;
	return {
		schemaVersion: 1,
		providerId: profile.providerId,
		referenceId: profile.referenceId,
		credentialGeneration: profile.credentialGeneration,
	};
}

function parseAccount(value: unknown): RecoveryAccount | undefined {
	const account = asRecord(value);
	const profile = parseRecoveryProfile(account?.profile);
	return account &&
		hasOnlyKeys(account, ["profile", "name"]) &&
		profile &&
		typeof account.name === "string"
		? { profile, name: account.name }
		: undefined;
}

export function parseRecoveryPolicy(
	value: unknown,
): RecoveryPolicy | undefined {
	const policy = asRecord(value);
	if (
		!policy ||
		!hasOnlyKeys(policy, [
			"schemaVersion",
			"providerId",
			"revision",
			"enabled",
			"accounts",
			"activatedAtMs",
			"updatedAtMs",
		]) ||
		policy.schemaVersion !== 1 ||
		typeof policy.providerId !== "string" ||
		!nonNegativeInteger(policy.revision) ||
		typeof policy.enabled !== "boolean" ||
		!Array.isArray(policy.accounts) ||
		!(
			policy.activatedAtMs === null || nonNegativeInteger(policy.activatedAtMs)
		) ||
		!nonNegativeInteger(policy.updatedAtMs)
	)
		return;
	const accounts = policy.accounts.map(parseAccount);
	if (
		accounts.some(
			(account) => !account || account.profile.providerId !== policy.providerId,
		)
	)
		return;
	return {
		schemaVersion: 1,
		providerId: policy.providerId,
		revision: policy.revision,
		enabled: policy.enabled,
		accounts: accounts as RecoveryAccount[],
		activatedAtMs: policy.activatedAtMs,
		updatedAtMs: policy.updatedAtMs,
	};
}

export function parseRecoveryObservation(
	value: unknown,
): RecoveryObservation | undefined {
	const observation = asRecord(value);
	const target =
		observation?.target === null ? null : parseAccount(observation?.target);
	const stopped = asRecord(observation?.stopped);
	if (
		!observation ||
		!hasOnlyKeys(observation, [
			"attemptId",
			"failureItemId",
			"target",
			"stopped",
			"turnState",
			"createdAtMs",
		]) ||
		!isDureDomainIdV1(observation.attemptId) ||
		!isDureDomainIdV1(observation.failureItemId) ||
		target === undefined ||
		!nonNegativeInteger(observation.createdAtMs) ||
		![null, "prepared", "accepted", "failed", "uncertain"].includes(
			observation.turnState as string | null,
		) ||
		!(
			observation.stopped === null ||
			(stopped &&
				((["exhausted", "superseded"].includes(String(stopped.kind)) &&
					hasOnlyKeys(stopped, ["kind"])) ||
					(stopped.kind === "failed" &&
						typeof stopped.code === "string" &&
						hasOnlyKeys(stopped, ["kind", "code"]))))
		)
	)
		return;
	return {
		attemptId: observation.attemptId,
		failureItemId: observation.failureItemId,
		target,
		stopped: observation.stopped as RecoveryObservation["stopped"],
		turnState: observation.turnState as RecoveryObservation["turnState"],
		createdAtMs: observation.createdAtMs,
	};
}
