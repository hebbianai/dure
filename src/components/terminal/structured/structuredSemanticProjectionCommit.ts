import {
	applyStructuredAgentProjection,
	type StructuredAgentRuntimeAttachmentFence,
} from "@/lib/agents/structuredAgentRuntimeProjection";
import type {
	HmuxAgentIdentity,
	HmuxAgentRuntimeState,
	HmuxWorkingDirectory,
} from "@/lib/ipc";
import type { StructuredTerminalAdapterRecord } from "@/lib/terminal/structuredTerminalRecord";

/** Store writes the transport owns; this module never touches the store so the
 * fence logic stays testable without a live attachment. */
export interface SemanticProjectionCommits {
	agentIdentity: (sessionId: string, identity: HmuxAgentIdentity) => void;
	agentRuntimeState: (sessionId: string, state: HmuxAgentRuntimeState) => void;
	workingDirectory: (
		sessionId: string,
		workingDirectory: HmuxWorkingDirectory,
	) => void;
}

/** Applies one Host semantic projection record under the attach fence.
 *
 * Returns `undefined` when the record is not a fenced semantic projection so
 * the caller keeps handling its remaining carrier kinds. */
export function applySemanticProjectionRecord(input: {
	record: StructuredTerminalAdapterRecord;
	fence: StructuredAgentRuntimeAttachmentFence | undefined;
	currentAttachmentToken: string | undefined;
	/** A projection outside its attach fence is a connection-level divergence;
	 * the successor attach settles it. */
	reject: (reason: string) => false;
	commits: SemanticProjectionCommits;
}): boolean | undefined {
	const { record, fence, currentAttachmentToken, reject, commits } = input;
	const install = <Projection extends { terminalEpoch: string }>(
		projection: Projection,
		label: string,
		commit: (sessionId: string, projection: Projection) => void,
	) => {
		if (!fence) return reject(`${label} arrived before its attach fence`);
		const disposition = applyStructuredAgentProjection({
			projection,
			attachment: fence,
			currentAttachmentToken,
			commit,
		});
		if (disposition === "epoch_mismatch")
			return reject(`${label} epoch does not match structured attachment`);
		return disposition === "applied";
	};
	if (record.kind === "agent_identity") {
		return install(record.identity, "agent identity", commits.agentIdentity);
	}
	if (record.kind === "agent_runtime_state") {
		return install(
			record.state,
			"agent runtime state",
			commits.agentRuntimeState,
		);
	}
	if (record.kind === "working_directory") {
		return install(
			record.workingDirectory,
			"working directory",
			commits.workingDirectory,
		);
	}
	return undefined;
}
