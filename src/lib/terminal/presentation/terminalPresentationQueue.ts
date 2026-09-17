import {
	type FrameBudgetScheduler,
	getFrameBudgetScheduler,
} from "@/lib/scheduling/frameBudgetScheduler";
import type { TerminalPresentationRole } from "./terminalPresentationRoleStore";

type PresentationAdmissionScheduler = Pick<FrameBudgetScheduler, "schedule">;
const PRESENTATION_SOURCE_PREFIX = "structured-terminal-presentation.";

/** Reads the existing admission queue; does not retain another backlog count. */
export function readPendingTerminalPresentations(): number {
	let pending = 0;
	for (const lane of Object.values(getFrameBudgetScheduler().getTelemetry())) {
		for (const [source, work] of Object.entries(lane.sources)) {
			if (source.startsWith(PRESENTATION_SOURCE_PREFIX)) pending += work.pending;
		}
	}
	return pending;
}
interface PresentationAdmissionPolicy {
	readonly initialBackground: boolean;
}
type PresentationAdmission = (
	role: TerminalPresentationRole,
	run: () => void,
	policy: PresentationAdmissionPolicy,
) => () => void;

export function admitTerminalPresentation(
	role: TerminalPresentationRole,
	run: () => void,
	policy: PresentationAdmissionPolicy,
	readScheduler: () => PresentationAdmissionScheduler = getFrameBudgetScheduler,
): () => void {
	return readScheduler().schedule(
		role === "background" ? "catchup" : "reveal",
		run,
		`${PRESENTATION_SOURCE_PREFIX}${role}`,
		role === "background"
			? { completion: "deferred", burst: policy.initialBackground }
			: { completion: "inline" },
	);
}

interface PendingPresentation<Attachment, Candidate> {
	attachment: Attachment;
	candidate: Candidate;
	role: TerminalPresentationRole;
	cancel: () => void;
}

export function createTerminalPresentationQueue<
	Attachment,
	Candidate,
>(options: {
	readonly readRole: () => TerminalPresentationRole;
	readonly admit?: PresentationAdmission;
	readonly isCurrent: (attachment: Attachment) => boolean;
	readonly commit: (attachment: Attachment, candidate: Candidate) => void;
}) {
	const admit = options.admit ?? admitTerminalPresentation;
	let pending: PendingPresentation<Attachment, Candidate> | null = null;
	// A mounted terminal has no held frame yet, so its first visible candidate is
	// reveal work even when the pane is not selected. Once one frame commits,
	// later background output keeps the shared catch-up admission contract.
	let presented = false;
	let backgroundWarmupCommitted = false;
	const readAdmissionRole = (): TerminalPresentationRole =>
		presented ? options.readRole() : "ungated";
	const commit = (attachment: Attachment, candidate: Candidate) => {
		if (!options.isCurrent(attachment)) return false;
		options.commit(attachment, candidate);
		presented = true;
		return true;
	};
	const cancel = (attachment?: Attachment) => {
		if (attachment !== undefined && pending?.attachment !== attachment) return;
		const retired = pending;
		pending = null;
		retired?.cancel();
	};
	const enqueue = (
		attachment: Attachment,
		candidate: Candidate,
		role: TerminalPresentationRole,
	) => {
		const unit: PendingPresentation<Attachment, Candidate> = {
			attachment,
			candidate,
			role,
			cancel: () => {},
		};
		pending = unit;
		unit.cancel = admit(
			role,
			() => {
				if (pending !== unit) return;
				pending = null;
				if (commit(attachment, unit.candidate) && role === "background") {
					backgroundWarmupCommitted = true;
				}
			},
			{
				initialBackground:
					role === "background" && !backgroundWarmupCommitted,
			},
		);
	};
	const reclassify = (
		unit: PendingPresentation<Attachment, Candidate>,
		role: TerminalPresentationRole,
		candidate = unit.candidate,
	) => {
		pending = null;
		unit.cancel();
		return enqueue(unit.attachment, candidate, role);
	};
	const schedule = (attachment: Attachment, candidate: Candidate) => {
		const role = readAdmissionRole();
		if (pending?.attachment === attachment) {
			if (pending.role === role) {
				pending.candidate = candidate;
				return;
			}
			return reclassify(pending, role, candidate);
		}
		cancel();
		return enqueue(attachment, candidate, role);
	};
	const refreshRole = () => {
		const role = readAdmissionRole();
		if (!pending || pending.role === role) return;
		reclassify(pending, role);
	};
	return { cancel, commit, refreshRole, schedule };
}
