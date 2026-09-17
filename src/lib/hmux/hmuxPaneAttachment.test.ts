import { describe, expect, it, vi } from "vitest";
import {
	exactHmuxPaneAttachmentIdentity,
	HmuxPaneAttachmentTimeoutError,
	waitForExactHmuxPaneAttachment,
	waitForExactHmuxPaneAttachmentAcrossWindows,
} from "@/lib/hmux/hmuxPaneAttachment";
import type { HmuxPaneAttachmentStatus } from "@/lib/ipc";

const target = {
	windowLabel: "main",
	desktopId: "desktop-a",
	panelId: "term:standalone-1",
	sessionId: "standalone-1",
	workspaceId: "workspace-1",
};

function createLogicalPollingClock() {
	// sleep만 즉시 반환하게 두고 Date.now를 쓰면, 병렬 suite의 CPU 지연이 10ms
	// 테스트 timeout을 소비한다. 두 시간원을 함께 전진시켜 poll 계약만 검사한다.
	let elapsedMs = 0;
	return {
		now: () => elapsedMs,
		sleep: vi.fn(async (milliseconds: number) => {
			elapsedMs += milliseconds;
		}),
	};
}

describe("exact Hmux pane attachment acknowledgement", () => {
	it("derives the same exact native owner identity as pane departure", () => {
		expect(exactHmuxPaneAttachmentIdentity(target)).toEqual({
			ownerId: "window:main:desktop:desktop-a:pane:term:standalone-1",
			sessionId: "standalone-1",
			workspaceId: "workspace-1",
		});
	});

	it("waits through detached status and returns only the exact attached ack", async () => {
		const identity = exactHmuxPaneAttachmentIdentity(target);
		const clock = createLogicalPollingClock();
		const read = vi
			.fn()
			.mockResolvedValueOnce({ ...identity, state: "detached" })
			.mockResolvedValueOnce({
				...identity,
				state: "attached",
				observerAttached: true,
				controllerAttached: false,
			});

		await expect(
			waitForExactHmuxPaneAttachment(target, read, {
				timeoutMs: 2,
				pollMs: 1,
				...clock,
			}),
		).resolves.toMatchObject({
			...identity,
			state: "attached",
			observerAttached: true,
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(clock.sleep).toHaveBeenCalledOnce();
		expect(clock.sleep).toHaveBeenCalledWith(1);
		expect(clock.now()).toBe(1);
	});

	it("returns the exact secondary owner when the coordinating window is detached", async () => {
		const main = exactHmuxPaneAttachmentIdentity(target);
		const secondary = exactHmuxPaneAttachmentIdentity({
			...target,
			windowLabel: "win-1788099326856-0",
		});
		const read = vi.fn(
			async (identity: typeof main): Promise<HmuxPaneAttachmentStatus> => {
				const observerAttached = identity.ownerId === secondary.ownerId;
				return {
					...identity,
					state: observerAttached ? "attached" : "detached",
					observerAttached,
					controllerAttached: false,
				};
			},
		);

		await expect(
			waitForExactHmuxPaneAttachmentAcrossWindows(
				{
					desktopId: target.desktopId,
					panelId: target.panelId,
					sessionId: target.sessionId,
					workspaceId: target.workspaceId,
				},
				["main", "win-1788099326856-0", "win-1788099326856-1"],
				read,
			),
		).resolves.toEqual({
			...secondary,
			state: "attached",
			observerAttached: true,
			controllerAttached: false,
		});
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("rejects a mismatched native identity instead of accepting a loose ack", async () => {
		const identity = exactHmuxPaneAttachmentIdentity(target);
		await expect(
			waitForExactHmuxPaneAttachment(target, async () => ({
				...identity,
				ownerId: "window:main:desktop:other:pane:term:standalone-1",
				state: "attached",
				observerAttached: true,
				controllerAttached: false,
			})),
		).rejects.toThrow("wrong identity");
	});

	it("returns a typed timeout when no attachment is published", async () => {
		const identity = exactHmuxPaneAttachmentIdentity(target);
		const clock = createLogicalPollingClock();
		const read = vi.fn(async () => ({
			...identity,
			state: "detached" as const,
			observerAttached: false,
			controllerAttached: false,
		}));
		await expect(
			waitForExactHmuxPaneAttachment(target, read, {
				timeoutMs: 2,
				pollMs: 1,
				...clock,
			}),
		).rejects.toBeInstanceOf(HmuxPaneAttachmentTimeoutError);
		expect(read).toHaveBeenCalledTimes(2);
		expect(clock.sleep).toHaveBeenCalledTimes(2);
		expect(clock.now()).toBe(2);
	});
});
