import {
	parseAgentEnvironmentReport,
	type AgentEnvironmentReport,
} from "@/lib/agents/agentEnvironment";
import { runShell } from "@/lib/ipc/process";
import {
	dureCliInstallStatus,
	type DureCliInstallStatus,
} from "@/lib/ipc/system";
import { shellQuote } from "@/lib/platform/shell";

export interface AgentToolingEnvironmentSnapshot {
	report: AgentEnvironmentReport;
	cliInstallStatus: DureCliInstallStatus | null;
	observed: boolean;
}

export interface AgentToolingEnvironmentDependencies {
	runCommand?: typeof runShell;
	readCliInstallStatus?: typeof dureCliInstallStatus;
}

/**
 * Route a doctor-owned `dure ...` command to the verified channel CLI. The
 * login shell may resolve a bare `dure` to an unrelated, older install, so
 * every probe and lifecycle command must address the same executable.
 */
export function resolveAgentToolingCommand(
	cliInstallStatus: DureCliInstallStatus | null,
	command: string,
): string {
	const executablePath = cliInstallStatus?.available.executablePath?.trim();
	const cli = executablePath ? shellQuote(executablePath) : "dure";
	return command === "dure"
		? cli
		: command.startsWith("dure ")
			? `${cli}${command.slice("dure".length)}`
			: command;
}

/** Read the installed CLI and integration receipts without changing them. */
export async function probeAgentToolingEnvironment(
	dependencies: AgentToolingEnvironmentDependencies = {},
): Promise<AgentToolingEnvironmentSnapshot> {
	const runCommand = dependencies.runCommand ?? runShell;
	const readCliInstallStatus =
		dependencies.readCliInstallStatus ?? dureCliInstallStatus;
	const cliInstallStatus = await readCliInstallStatus().catch(() => null);
	const [doctor, version] = await Promise.all([
		runCommand(
			resolveAgentToolingCommand(cliInstallStatus, "dure doctor --json"),
		).catch(() => null),
		runCommand(
			resolveAgentToolingCommand(cliInstallStatus, "dure --version"),
		).catch(() => null),
	]);
	return {
		report: parseAgentEnvironmentReport(
			doctor,
			version,
			cliInstallStatus?.state,
		),
		cliInstallStatus,
		observed: doctor !== null || version !== null || cliInstallStatus !== null,
	};
}
