import { pathBasename } from "@/lib/files/paths";
import { t } from "@/lib/i18n";
import { PROVIDERS, type Provider } from "@/types";

/** What a plain shell row is named by. */
export interface ShellRowTitleFacts {
	/** The SSH target, when the shell runs ssh to another machine. */
	readonly sshTarget?: string;
	/** The provider found running in it. */
	readonly provider: Provider | null;
	readonly cwd: string;
}

/** A plain shell row's title wherever the row is named — the Spaces row, and
 * the path of an agent it started: the SSH target, else the provider found
 * in it, else its folder, else "shell". */
export function shellRowTitle({
	sshTarget,
	provider,
	cwd,
}: ShellRowTitleFacts): string {
	return (
		sshTarget ||
		(provider ? PROVIDERS[provider].label : "") ||
		pathBasename(cwd) ||
		t("spaces.session.shell")
	);
}
