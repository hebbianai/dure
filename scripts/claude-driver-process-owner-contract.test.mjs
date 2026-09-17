import assert from "node:assert/strict";
import { test } from "vitest";

import { runSingleClaudeRuntime } from "../crates/dure-app/control-plane/provider-drivers/claude/process-owner.mjs";

test("the Claude driver launches and observes exactly one provider runtime", async () => {
	let launches = 0;
	let complete;
	const completion = new Promise((resolve) => {
		complete = resolve;
	});

	const running = runSingleClaudeRuntime({
		launch: () => {
			launches += 1;
			return { child: { pid: 42 }, completion };
		},
	});

	await Promise.resolve();
	assert.equal(launches, 1);
	complete({ code: 0, signal: null });
	assert.deepEqual(await running, { code: 0, signal: null });
	assert.equal(launches, 1);
});

test("the Claude driver rejects launch handles without one observable child", async () => {
	await assert.rejects(
		runSingleClaudeRuntime({
			launch: () => ({ child: {}, completion: Promise.resolve({ code: 0, signal: null }) }),
		}),
		(error) =>
			error?.code === "DURE_CLAUDE_DRIVER_CONTRACT" &&
			error.message === "dure_claude_driver_invalid_runtime",
	);
});
