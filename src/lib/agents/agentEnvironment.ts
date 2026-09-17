// Parse the bounded agent-tooling contract returned by `dure doctor --json`.
// Commands cross a shell boundary, so only exact commands owned by the current
// contract survive parsing and become actionable UI data.

type AgentIntegrationProvider = "claude" | "codex";
type AgentIntegrationStatus =
	| "current"
	| "outdated"
	| "missing"
	| "invalid";

export interface AgentEnvironmentIntegrationDetail {
	provider: AgentIntegrationProvider;
	status: AgentIntegrationStatus;
	installRoot: string;
	installRootRef: string | null;
	version: string | null;
	digest: string | null;
	channel: string | null;
	transportRef: string | null;
	capabilities: string[];
	fixCommand: string;
	updateCommand: string;
	uninstallCommand: string;
	refreshCommand: string | null;
}

type AgentSkillState =
	| "current"
	| "outdated"
	| "modified"
	| "unmanaged"
	| "missing";

export interface AgentEnvironmentSkillDetail {
	provider: AgentIntegrationProvider;
	name: string;
	state: AgentSkillState;
	target: string;
	fixCommand: string;
	updateCommand: string;
}

interface AgentEnvironmentDependency {
	id: string;
	label: string;
	ok: boolean;
	fixCommand: string;
	updateCommand?: string;
	uninstallCommand?: string;
	details?: AgentEnvironmentIntegrationDetail[] | AgentEnvironmentSkillDetail[];
}

/** `outdated` means an installed CLI update is available. A valid doctor
 * response may still attest a compatible immutable integration receipt. */
type AgentCliState = "ok" | "outdated" | "missing";
export type AgentCliInstallState = "current" | "outdated" | "missing";

export interface AgentEnvironmentReport {
	cliState: AgentCliState;
	dependencies: AgentEnvironmentDependency[];
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

const INTEGRATION_PROVIDERS = new Set<AgentIntegrationProvider>([
	"claude",
	"codex",
]);
const INTEGRATION_STATUSES = new Set<AgentIntegrationStatus>([
	"current",
	"outdated",
	"missing",
	"invalid",
]);
const SKILL_STATES = new Set<AgentSkillState>([
	"current",
	"outdated",
	"modified",
	"unmanaged",
	"missing",
]);
/** Pinned before any other field is checked: per-detail commands are built
 * from `name`, so an unshaped name could still spell an owned command. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function integrationCommand(
	action: "install" | "update" | "refresh" | "uninstall",
	provider?: AgentIntegrationProvider,
): string {
	if (action === "refresh") {
		return `dure integration refresh --global --provider ${provider}`;
	}
	return `dure integration ${action} --global${provider ? ` --provider ${provider}` : ""} --approve-global-config`;
}

function skillCommand(
	action: "install" | "update",
	name: string,
	provider: AgentIntegrationProvider,
): string {
	return `dure skills ${action} ${name} --global --provider ${provider}`;
}

function dependencyCommandIsOwned(
	dependency: Partial<AgentEnvironmentDependency>,
): boolean {
	switch (dependency.id) {
		case "orchestration-integration":
			return (
				dependency.fixCommand === integrationCommand("install") &&
				dependency.updateCommand === integrationCommand("update") &&
				dependency.uninstallCommand === integrationCommand("uninstall")
			);
		case "session-hook":
		case "codex-session-hook":
		case "gemini-session-hook":
			return dependency.fixCommand === "dure hooks install --global";
		case "dure-skills":
			return (
				dependency.fixCommand === "dure skills install --global" &&
				dependency.updateCommand === "dure skills update --all --global"
			);
		default:
			return false;
	}
}

function parseIntegrationDetails(
	value: unknown,
): AgentEnvironmentIntegrationDetail[] | null {
	if (!Array.isArray(value)) return null;
	const providers = new Set<AgentIntegrationProvider>();
	const details: AgentEnvironmentIntegrationDetail[] = [];
	for (const entry of value) {
		const candidate = entry as Partial<AgentEnvironmentIntegrationDetail>;
		if (
			!INTEGRATION_PROVIDERS.has(
				candidate.provider as AgentIntegrationProvider,
			) ||
			providers.has(candidate.provider as AgentIntegrationProvider) ||
			!INTEGRATION_STATUSES.has(candidate.status as AgentIntegrationStatus) ||
			!isString(candidate.installRoot) ||
			(candidate.installRootRef !== null &&
				!isString(candidate.installRootRef)) ||
			(candidate.version !== null && !isString(candidate.version)) ||
			(candidate.digest !== null && !isString(candidate.digest)) ||
			(candidate.channel !== null && !isString(candidate.channel)) ||
			(candidate.transportRef !== null && !isString(candidate.transportRef)) ||
			!Array.isArray(candidate.capabilities) ||
			!candidate.capabilities.every(isString)
		) {
			return null;
		}
		const provider = candidate.provider as AgentIntegrationProvider;
		if (
			candidate.fixCommand !== integrationCommand("install", provider) ||
			candidate.updateCommand !== integrationCommand("update", provider) ||
			candidate.uninstallCommand !== integrationCommand("uninstall", provider) ||
			(candidate.refreshCommand !== null &&
				candidate.refreshCommand !== integrationCommand("refresh", provider))
		) {
			return null;
		}
		providers.add(provider);
		details.push(candidate as AgentEnvironmentIntegrationDetail);
	}
	return providers.size === INTEGRATION_PROVIDERS.size ? details : null;
}

/** Unlike integrations, skills are not required on every provider: a machine
 * with no `~/.codex` legitimately reports Claude only, and `details: []` is
 * valid. Duplicate detection keys on provider *and* name together. */
function parseSkillDetails(
	value: unknown,
): AgentEnvironmentSkillDetail[] | null {
	if (!Array.isArray(value)) return null;
	const seen = new Set<string>();
	const details: AgentEnvironmentSkillDetail[] = [];
	for (const entry of value) {
		const candidate = entry as Partial<AgentEnvironmentSkillDetail>;
		// Pin the shape of `name` before anything else: per-detail commands are
		// built from it, so an unshaped name could still spell an owned command.
		if (!isString(candidate.name) || !SKILL_NAME_PATTERN.test(candidate.name)) {
			return null;
		}
		if (
			!INTEGRATION_PROVIDERS.has(
				candidate.provider as AgentIntegrationProvider,
			) ||
			!SKILL_STATES.has(candidate.state as AgentSkillState) ||
			!isString(candidate.target)
		) {
			return null;
		}
		const provider = candidate.provider as AgentIntegrationProvider;
		const key = `${provider}:${candidate.name}`;
		if (seen.has(key)) return null;
		if (
			candidate.fixCommand !==
				skillCommand("install", candidate.name, provider) ||
			candidate.updateCommand !==
				skillCommand("update", candidate.name, provider)
		) {
			return null;
		}
		seen.add(key);
		details.push(candidate as AgentEnvironmentSkillDetail);
	}
	return details;
}

/** Parse bounded doctor evidence and retain only owned lifecycle commands. */
export function parseAgentEnvironmentReport(
	result: { code: number; stdout: string } | null,
	versionProbe?: { code: number; stdout: string } | null,
	channelInstallState?: AgentCliInstallState,
): AgentEnvironmentReport {
	if (channelInstallState === "missing") {
		return { cliState: "missing", dependencies: [] };
	}
	const cliPresent =
		versionProbe?.code === 0 && versionProbe.stdout.trim().length > 0;
	const unavailable: AgentEnvironmentReport = {
		cliState:
			channelInstallState === "outdated" || cliPresent ? "outdated" : "missing",
		dependencies: [],
	};
	if (result?.code !== 0) return unavailable;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return unavailable;
	}
	const report = parsed as {
		schemaVersion?: unknown;
		dependencies?: unknown;
	};
	if (report.schemaVersion !== 1 || !Array.isArray(report.dependencies)) {
		return unavailable;
	}
	const dependencies: AgentEnvironmentDependency[] = [];
	for (const entry of report.dependencies) {
		const dependency = entry as Partial<AgentEnvironmentDependency>;
		if (
			typeof dependency.id !== "string" ||
			typeof dependency.label !== "string" ||
			typeof dependency.ok !== "boolean" ||
			typeof dependency.fixCommand !== "string" ||
			!dependencyCommandIsOwned(dependency)
		) {
			continue; // Unknown entries must never become executable installation actions.
		}
		let details:
			| AgentEnvironmentIntegrationDetail[]
			| AgentEnvironmentSkillDetail[]
			| undefined;
		if (dependency.id === "orchestration-integration") {
			const parsedDetails = parseIntegrationDetails(dependency.details);
			if (
				parsedDetails === null ||
				dependency.ok !==
					parsedDetails.every((detail) => detail.status === "current")
			) {
				continue;
			}
			details = parsedDetails;
		} else if (dependency.id === "dure-skills") {
			const parsedDetails = parseSkillDetails(dependency.details);
			if (
				parsedDetails === null ||
				dependency.ok !==
					parsedDetails.every((detail) => detail.state === "current")
			) {
				continue;
			}
			details = parsedDetails;
		}
		dependencies.push({
			id: dependency.id,
			label: dependency.label,
			ok: dependency.ok,
			fixCommand: dependency.fixCommand,
			...(typeof dependency.updateCommand === "string"
				? { updateCommand: dependency.updateCommand }
				: {}),
			...(typeof dependency.uninstallCommand === "string"
				? { uninstallCommand: dependency.uninstallCommand }
				: {}),
			...(details ? { details } : {}),
		});
	}
	if (
		!dependencies.some(
			(dependency) => dependency.id === "orchestration-integration",
		)
	) {
		return { cliState: "outdated", dependencies: [] };
	}
	return {
		cliState: channelInstallState === "outdated" ? "outdated" : "ok",
		dependencies,
	};
}

/** Number of required actions used by badges and summary copy. */
export function missingDependencyCount(report: AgentEnvironmentReport): number {
	if (report.cliState !== "ok") return 1; // The CLI is the first required dependency.
	return report.dependencies.filter((dependency) => !dependency.ok).length;
}

// Both accessors below cast rather than narrow, because TypeScript cannot
// infer a detail's element type from a sibling `id` check. The cast is sound
// only because `parseAgentEnvironmentReport` is the single producer of an
// `AgentEnvironmentReport` and is what enforces the id-to-shape
// correspondence: it assigns `details` exclusively inside the branch that
// matched the id, so a dependency carrying the wrong detail shape is dropped
// before it can be returned. Keep these two functions the only place that
// reads `details` directly — a hand-built report that skips the parser would
// make the cast a lie, and these are the containment point for that.

/** The orchestration integration's per-provider records, or [] if absent. */
export function integrationDetailsOf(
	report: AgentEnvironmentReport,
): AgentEnvironmentIntegrationDetail[] {
	const dependency = report.dependencies.find(
		(candidate) => candidate.id === "orchestration-integration",
	);
	return (
		(dependency?.details as AgentEnvironmentIntegrationDetail[] | undefined) ??
		[]
	);
}

/** Every shipped skill's per-provider record, or [] if absent. */
export function skillDetailsOf(
	report: AgentEnvironmentReport,
): AgentEnvironmentSkillDetail[] {
	const dependency = report.dependencies.find(
		(candidate) => candidate.id === "dure-skills",
	);
	return (
		(dependency?.details as AgentEnvironmentSkillDetail[] | undefined) ?? []
	);
}
