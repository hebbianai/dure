import {
	asRecord,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
} from "@/lib/payloadGuards";

const environmentStatuses = [
	"creating",
	"running",
	"suspending",
	"suspended",
	"resuming",
	"destroying",
	"failed",
	"cleanup_failed",
	"destroyed",
] as const;
type EnvironmentStatus = (typeof environmentStatuses)[number];
export type EnvironmentOperation = "suspend" | "resume" | "destroy";
interface EnvironmentConnection {
	host: string;
	port: number;
	user: string;
	keyPath: string | null;
	projectRoot: string;
}
export interface WorkspaceEnvironment {
	id: string;
	revision: number;
	name: string;
	projectPath: string;
	recipeId: string;
	recipeName: string;
	status: EnvironmentStatus;
	error: string | null;
	createdAtMs: number;
	updatedAtMs: number;
	canSuspend: boolean;
	connection: EnvironmentConnection | null;
}
export interface EnvironmentRecipe {
	id: string;
	name: string;
	digest: string;
	canSuspend: boolean;
}

function isStatus(value: unknown): value is EnvironmentStatus {
	return environmentStatuses.some((status) => status === value);
}
function address(value: unknown): value is string {
	return (
		nonEmptyString(value) &&
		value.length <= 255 &&
		!/^[-]|[\s\p{Cc}]/u.test(value)
	);
}
function absolutePath(value: unknown): value is string {
	return (
		nonEmptyString(value) &&
		value.startsWith("/") &&
		value.length <= 4096 &&
		!/[\p{Cc}]/u.test(value)
	);
}
function parseEnvironmentConnection(
	value: unknown,
): EnvironmentConnection | null {
	const record = asRecord(value);
	if (
		!record ||
		!address(record.host) ||
		!address(record.user) ||
		!positiveInteger(record.port) ||
		record.port > 65535 ||
		!absolutePath(record.projectRoot) ||
		(record.keyPath != null && !absolutePath(record.keyPath))
	)
		return null;
	return {
		host: record.host,
		port: record.port,
		user: record.user,
		projectRoot: record.projectRoot,
		keyPath: record.keyPath ?? null,
	};
}
export function parseEnvironment(value: unknown): WorkspaceEnvironment | null {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.id !== "string" ||
		!/^env-[0-9a-f]{64}$/u.test(record.id) ||
		!positiveInteger(record.revision) ||
		!nonEmptyString(record.name) ||
		!absolutePath(record.projectPath) ||
		!nonEmptyString(record.recipeId) ||
		!nonEmptyString(record.recipeName) ||
		!isStatus(record.status) ||
		(record.error !== null && typeof record.error !== "string") ||
		!nonNegativeInteger(record.createdAtMs) ||
		!nonNegativeInteger(record.updatedAtMs) ||
		typeof record.canSuspend !== "boolean"
	)
		return null;
	const connection = parseEnvironmentConnection(record.connection);
	if (
		(record.connection !== null && !connection) ||
		(["running", "suspended", "resuming", "suspending"].includes(
			record.status,
		) &&
			!connection)
	)
		return null;
	return {
		id: record.id,
		revision: record.revision,
		name: record.name,
		projectPath: record.projectPath,
		recipeId: record.recipeId,
		recipeName: record.recipeName,
		status: record.status,
		error: record.error,
		createdAtMs: record.createdAtMs,
		updatedAtMs: record.updatedAtMs,
		canSuspend: record.canSuspend,
		connection,
	};
}
export function parseEnvironmentRecipe(
	value: unknown,
): EnvironmentRecipe | null {
	const record = asRecord(value);
	if (
		!record ||
		!nonEmptyString(record.id) ||
		!nonEmptyString(record.name) ||
		typeof record.digest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/u.test(record.digest) ||
		typeof record.canSuspend !== "boolean"
	)
		return null;
	return {
		id: record.id,
		name: record.name,
		digest: record.digest,
		canSuspend: record.canSuspend,
	};
}
export function environmentPending(environment: WorkspaceEnvironment): boolean {
	return ["creating", "suspending", "resuming", "destroying"].includes(
		environment.status,
	);
}
export function environmentActions(
	environment: WorkspaceEnvironment,
	pro: boolean,
): EnvironmentOperation[] {
	if (environmentPending(environment) || environment.status === "destroyed")
		return [];
	const actions: EnvironmentOperation[] = [];
	if (environment.canSuspend && environment.status === "running")
		actions.push("suspend");
	if (
		pro &&
		environment.canSuspend &&
		environment.connection &&
		["suspended", "failed"].includes(environment.status)
	)
		actions.push("resume");
	actions.push("destroy");
	return actions;
}
