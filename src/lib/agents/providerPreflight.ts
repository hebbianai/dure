import { type ProviderPreflight, providerPreflight } from "@/lib/ipc";
import {
	PROVIDERS,
	type Project,
	type Provider,
	type TerminalEnvironment,
} from "@/types";

export class ProviderPreflightError extends Error {
	constructor(readonly preflight: ProviderPreflight) {
		super(preflight.message);
		this.name = "ProviderPreflightError";
	}
}

export function providerExecutable(provider: Provider): string {
	const executable = PROVIDERS[provider].cmd.trim().split(/\s+/, 1)[0];
	if (!executable)
		throw new Error(`Provider ${provider} has no executable command`);
	return executable;
}

/** Resolve the executable in the spawn environment. Version diagnostics are
 * opt-in for callers whose credential adapter needs them. */
export async function requireProjectProvider(
	project: Pick<Project, "kind" | "path">,
	provider: Provider,
	options: { terminalEnv?: TerminalEnvironment; includeVersion?: boolean } = {},
): Promise<ProviderPreflight | undefined> {
	if (project.kind !== "local") return undefined;
	const result = await providerPreflight({
		provider,
		command: providerExecutable(provider),
		cwd: project.path,
		terminalEnv: options.terminalEnv,
		includeVersion: options.includeVersion ?? false,
	});
	if (!result.executable) throw new ProviderPreflightError(result);
	return result;
}
