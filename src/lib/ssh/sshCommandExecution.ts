declare const BOUNDED_STDIN_COMMAND: unique symbol;

export interface BoundedStdinCommandExecution {
	readonly command: string;
	readonly stdin: string;
	readonly [BOUNDED_STDIN_COMMAND]: true;
}

export type SshCommandSource = string | BoundedStdinCommandExecution;

interface PlainSshCommandExecution {
	readonly command: string;
}

/** A command that owns its bounded stdin protocol and parses it before mutation. */
export function boundedStdinCommand(
	command: string,
	stdin: string,
): BoundedStdinCommandExecution {
	return { command, stdin } as BoundedStdinCommandExecution;
}

export function sshCommandExecution(source: string): PlainSshCommandExecution;
export function sshCommandExecution(
	source: BoundedStdinCommandExecution,
): BoundedStdinCommandExecution;
export function sshCommandExecution(
	source: SshCommandSource,
): PlainSshCommandExecution | BoundedStdinCommandExecution;
export function sshCommandExecution(
	source: SshCommandSource,
): PlainSshCommandExecution | BoundedStdinCommandExecution {
	return typeof source === "string" ? { command: source } : source;
}
