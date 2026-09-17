import { describe, expect, it, vi } from "vitest";
import {
	type PostPaintHost,
	type PostPaintTaskScheduler,
	schedulePostPaint,
} from "./postPaint";

function testHost() {
	let frame: FrameRequestCallback | undefined;
	let nextTask = 2;
	const taskCallbacks = new Map<number, () => void>();
	const host: PostPaintHost = {
		requestAnimationFrame: vi.fn((callback) => {
			frame = callback;
			return 1;
		}),
		cancelAnimationFrame: vi.fn(),
	};
	const tasks: PostPaintTaskScheduler = {
		request: vi.fn((callback) => {
			const handle = nextTask++;
			taskCallbacks.set(handle, callback);
			return handle;
		}),
		cancel: vi.fn((handle) => taskCallbacks.delete(handle)),
	};
	return {
		host,
		tasks,
		paint: () => frame?.(0),
		flushTask: () => {
			const next = taskCallbacks.entries().next().value as
				| [number, () => void]
				| undefined;
			if (!next) return;
			taskCallbacks.delete(next[0]);
			next[1]();
		},
	};
}

describe("schedulePostPaint", () => {
	it("runs after the frame has yielded to the next browser task", () => {
		const fixture = testHost();
		const callback = vi.fn();
		const onFrame = vi.fn();
		schedulePostPaint(fixture.host, callback, {
			tasks: fixture.tasks,
			onFrame,
		});

		fixture.paint();
		expect(onFrame).toHaveBeenCalledOnce();
		expect(callback).not.toHaveBeenCalled();
		fixture.flushTask();
		expect(callback).toHaveBeenCalledOnce();
	});

	it("observes task availability without changing the frame and postpaint order", () => {
		const fixture = testHost();
		const callback = vi.fn();
		const onTask = vi.fn();
		const onFrame = vi.fn();
		schedulePostPaint(fixture.host, callback, {
			tasks: fixture.tasks,
			onTask,
			onFrame,
		});

		fixture.flushTask();
		expect(onTask).toHaveBeenCalledOnce();
		expect(onFrame).not.toHaveBeenCalled();
		fixture.paint();
		expect(onFrame).toHaveBeenCalledOnce();
		expect(callback).not.toHaveBeenCalled();
		fixture.flushTask();
		expect(callback).toHaveBeenCalledOnce();
	});

	it("cancels either pending phase", () => {
		const beforeFrame = testHost();
		const first = vi.fn();
		const beforeTask = vi.fn();
		const cancelBeforeFrame = schedulePostPaint(
			beforeFrame.host,
			first,
			{ tasks: beforeFrame.tasks, onTask: beforeTask },
		);
		cancelBeforeFrame();
		beforeFrame.paint();
		beforeFrame.flushTask();
		expect(first).not.toHaveBeenCalled();
		expect(beforeTask).not.toHaveBeenCalled();
		expect(beforeFrame.host.cancelAnimationFrame).toHaveBeenCalledWith(1);
		expect(beforeFrame.tasks.cancel).toHaveBeenCalledWith(2);

		const afterFrame = testHost();
		const second = vi.fn();
		const cancelAfterFrame = schedulePostPaint(
			afterFrame.host,
			second,
			{ tasks: afterFrame.tasks },
		);
		afterFrame.paint();
		cancelAfterFrame();
		afterFrame.flushTask();
		expect(second).not.toHaveBeenCalled();
		expect(afterFrame.tasks.cancel).toHaveBeenCalledWith(2);
	});
});
