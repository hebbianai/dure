import { describe, expect, it, vi } from "vitest";
import type { SchedulerLane } from "@/lib/scheduling/frameBudgetScheduler";
import {
	admitTerminalPresentation,
	createTerminalPresentationQueue,
} from "./terminalPresentationQueue";

describe("terminal presentation queue", () => {
	it("reveals the first visible candidate before gating later background updates", () => {
		const admissions: Array<{ role: string; run: () => void }> = [];
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => "background",
			admit: (role, run) => {
				admissions.push({ role, run });
				return vi.fn();
			},
			isCurrent: () => true,
			commit: vi.fn(),
		});
		const attachment = {};

		queue.schedule(attachment, "first visible frame");
		expect(admissions.map(({ role }) => role)).toEqual(["ungated"]);
		admissions[0]?.run();

		queue.schedule(attachment, "later background frame");
		expect(admissions.map(({ role }) => role)).toEqual([
			"ungated",
			"background",
		]);
	});

	it("coalesces the latest candidate behind one role admission", () => {
		const admissions: Array<() => void> = [];
		const commit = vi.fn();
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => "background",
			admit: (_role, run) => {
				admissions.push(run);
				return vi.fn();
			},
			isCurrent: () => true,
			commit,
		});
		const attachment = {};

		queue.schedule(attachment, "older");
		queue.schedule(attachment, "newest");
		expect(admissions).toHaveLength(1);

		admissions[0]?.();
		expect(commit).toHaveBeenCalledWith(attachment, "newest");
	});

	it("promotes a pending candidate when hover changes its role without a new frame", () => {
		let role: "background" | "hovered" = "background";
		const admissions: Array<{ role: string; run: () => void }> = [];
		const cancellations: Array<ReturnType<typeof vi.fn>> = [];
		const commit = vi.fn();
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => role,
			admit: (admittedRole, run) => {
				admissions.push({ role: admittedRole, run });
				const cancel = vi.fn();
				cancellations.push(cancel);
				return cancel;
			},
			isCurrent: () => true,
			commit,
		});
		const attachment = {};

		queue.schedule(attachment, "first visible frame");
		admissions[0]?.run();
		queue.schedule(attachment, "background candidate");
		role = "hovered";
		queue.refreshRole();

		expect(cancellations[1]).toHaveBeenCalledOnce();
		expect(admissions.map((admission) => admission.role)).toEqual([
			"ungated",
			"background",
			"hovered",
		]);
		admissions[1]?.run();
		expect(commit).toHaveBeenCalledTimes(1);
		admissions[2]?.run();
		expect(commit).toHaveBeenCalledWith(attachment, "background candidate");
	});

	it("promotes background painting without exposing a transport admission", () => {
		let role: "background" | "foreground" = "background";
		const admissions: Array<{ role: string; run: () => void }> = [];
		const commit = vi.fn();
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => role,
			admit: (admittedRole, run) => {
				admissions.push({ role: admittedRole, run });
				return vi.fn();
			},
			isCurrent: () => true,
			commit,
		});
		const attachment = {};
		queue.schedule(attachment, "first visible frame");
		admissions[0]?.run();
		const admission = queue.schedule(attachment, "background candidate");
		expect(admission).toBeUndefined();

		role = "foreground";
		queue.refreshRole();

		admissions[1]?.run();
		expect(commit).toHaveBeenCalledTimes(1);

		admissions[2]?.run();
		expect(commit).toHaveBeenCalledTimes(2);
	});

	it("cancels background painting when its attachment is retired", () => {
		const admissions: Array<{
			run: () => void;
			cancel: ReturnType<typeof vi.fn>;
		}> = [];
		const attachment = {};
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => "background",
			admit: (_role, run) => {
				const cancel = vi.fn();
				admissions.push({ run, cancel });
				return cancel;
			},
			isCurrent: () => true,
			commit: vi.fn(),
		});
		queue.schedule(attachment, "first visible frame");
		admissions[0]?.run();
		const admission = queue.schedule(attachment, "retired candidate");
		expect(admission).toBeUndefined();

		queue.cancel(attachment);

		expect(admissions[1]?.cancel).toHaveBeenCalledOnce();
	});

	it("grants a cold burst only until one background frame commits", () => {
		const admissions: Array<{
			role: string;
			initialBackground: boolean;
			run: () => void;
		}> = [];
		const queue = createTerminalPresentationQueue<object, string>({
			readRole: () => "background",
			admit: (role, run, policy) => {
				admissions.push({
					role,
					initialBackground: policy.initialBackground,
					run,
				});
				return vi.fn();
			},
			isCurrent: () => true,
			commit: vi.fn(),
		});
		const attachment = {};

		queue.schedule(attachment, "first visible frame");
		admissions[0]?.run();
		queue.schedule(attachment, "cold background frame");
		admissions[1]?.run();
		queue.schedule(attachment, "steady background frame");

		expect(
			admissions.map(({ role, initialBackground }) => ({
				role,
				initialBackground,
			})),
		).toEqual([
			{ role: "ungated", initialBackground: false },
			{ role: "background", initialBackground: true },
			{ role: "background", initialBackground: false },
		]);
	});

	it("maps interactive roles to reveal and background ownership to catchup", () => {
		const cancel = vi.fn();
		const schedule = vi.fn(
			(
				_lane: SchedulerLane,
				_run: () => void,
				_source?: string,
				_policy?: { completion: "inline" | "deferred"; burst?: boolean },
			) => cancel,
		);
		const readScheduler = () => ({ schedule });
		const run = vi.fn();

		expect(
			admitTerminalPresentation(
				"background",
				run,
				{ initialBackground: true },
				readScheduler,
			),
		).toBe(cancel);
		admitTerminalPresentation(
			"foreground",
			run,
			{ initialBackground: false },
			readScheduler,
		);
		admitTerminalPresentation(
			"hovered",
			run,
			{ initialBackground: false },
			readScheduler,
		);
		admitTerminalPresentation(
			"ungated",
			run,
			{ initialBackground: false },
			readScheduler,
		);

		expect(
			schedule.mock.calls.map(([lane, , source, policy]) => [
				lane,
				source,
				policy,
			]),
		).toEqual([
			[
				"catchup",
				"structured-terminal-presentation.background",
				{ completion: "deferred", burst: true },
			],
			[
				"reveal",
				"structured-terminal-presentation.foreground",
				{ completion: "inline" },
			],
			[
				"reveal",
				"structured-terminal-presentation.hovered",
				{ completion: "inline" },
			],
			[
				"reveal",
				"structured-terminal-presentation.ungated",
				{ completion: "inline" },
			],
		]);
	});
});
