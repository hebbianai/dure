import { computeTextDigest } from "@/lib/agents/promptIdentity";
import { isRecord } from "@/lib/payloadGuards";
import { parseMountedPaneWindow } from "@/lib/workspace/window/mountedPaneWindow";
import {
	mountedWindowIdentifier,
	parseMountedWorkspaceWindow,
} from "@/lib/workspace/window/mountedWindowIdentity";
import { parseAgentChatDraftTarget } from "./agentChatDraftInput";
import type {
	AgentChatDrafts,
	AgentChatDraftTransfer,
} from "./agentChatDraftMove";

export type AgentChatDraftMoveRequest =
	| { step: "stage"; transfer: AgentChatDraftTransfer; drafts: AgentChatDrafts }
	| { step: "commit" | "abort" | "status"; transfer: AgentChatDraftTransfer };

export function parseAgentChatDraftMoveRequest(
	value: unknown,
): AgentChatDraftMoveRequest | undefined {
	if (!isRecord(value) || !isRecord(value.transfer)) return undefined;
	const raw = value.transfer;
	const target = parseAgentChatDraftTarget(raw.target);
	const source = parseMountedPaneWindow(raw.source);
	const destination = parseMountedWorkspaceWindow(raw.destination);
	if (
		!mountedWindowIdentifier(raw.id) ||
		typeof raw.digest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(raw.digest) ||
		!target ||
		!source ||
		!destination ||
		source.desktopId === destination.desktopId ||
		source.windowLabel === destination.windowLabel
	)
		return undefined;
	const transfer = {
		id: raw.id,
		digest: raw.digest,
		target,
		source,
		destination,
	};
	if (
		value.step === "commit" ||
		value.step === "abort" ||
		value.step === "status"
	)
		return { step: value.step, transfer };
	if (value.step !== "stage" || !isRecord(value.drafts)) return undefined;
	const entries: Array<[string, AgentChatDrafts[string]]> = [];
	for (const [key, draft] of Object.entries(value.drafts).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		let identity: unknown;
		try {
			identity = JSON.parse(key);
		} catch {
			return undefined;
		}
		if (
			!Array.isArray(identity) ||
			identity.length !== 2 ||
			!identity.every(mountedWindowIdentifier) ||
			JSON.stringify(identity) !== key ||
			!isRecord(draft) ||
			typeof draft.text !== "string" ||
			!Array.isArray(draft.attachments)
		)
			return undefined;
		const attachments: AgentChatDrafts[string]["attachments"] = [];
		for (const file of draft.attachments) {
			if (
				!isRecord(file) ||
				typeof file.fileName !== "string" ||
				typeof file.dataB64 !== "string"
			)
				return undefined;
			attachments.push({ fileName: file.fileName, dataB64: file.dataB64 });
		}
		// Moving composition is not submission: whitespace, large unfinished
		// text and images accumulated across batches are preserved byte for byte.
		entries.push([key, { text: draft.text, attachments }]);
	}
	return { step: "stage", transfer, drafts: Object.fromEntries(entries) };
}

export function draftTransferDigest(
	transfer: Omit<AgentChatDraftTransfer, "digest">,
	drafts: AgentChatDrafts,
): Promise<string> {
	return computeTextDigest(
		JSON.stringify({
			id: transfer.id,
			target: transfer.target,
			source: transfer.source,
			destination: transfer.destination,
			drafts,
		}),
	);
}
