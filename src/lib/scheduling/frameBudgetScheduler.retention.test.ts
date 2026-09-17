// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

function compiledModuleUrl(
	name: string,
	dependencies: Record<string, string> = {},
) {
	let code = ts.transpileModule(
		readFileSync(new URL(name, import.meta.url), "utf8"),
		{
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
			},
		},
	).outputText;
	for (const [specifier, url] of Object.entries(dependencies)) {
		code = code.replace(JSON.stringify(specifier), JSON.stringify(url));
	}
	return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

it("releases retired callbacks without another wake, even when callers retain cancellation handles", () => {
	const budget = compiledModuleUrl("./foregroundInteractionBudget.ts");
	const scheduler = compiledModuleUrl("./frameBudgetScheduler.ts", {
		"./foregroundInteractionBudget": budget,
	});
	// A separate real V8 process gives this resource-lifecycle assertion a full
	// GC after WeakRef's current-job keep-alive ends, without changing Vitest GC.
	const result = spawnSync(
		process.execPath,
		["--expose-gc", "--input-type=module"],
		{
			encoding: "utf8",
			timeout: 10_000,
			input: `
import { setImmediate } from "node:timers/promises";
const { FrameBudgetScheduler } = await import(${JSON.stringify(scheduler)});
let frame;
let nextHandle = 1;
const host = {
  now: () => 0,
  requestFrame: callback => { frame = callback; return nextHandle++; },
  cancelFrame: () => { frame = undefined; },
  setTimeout: () => nextHandle++,
  clearTimeout: () => {},
};
const scheduler = new FrameBudgetScheduler(host);
const cancelled = [];
const handles = [];
function schedulePayload(lane, refs, keepHandle) {
  const payload = new Uint8Array(32 * 1024);
  refs.push(new WeakRef(payload));
  const cancel = scheduler.schedule(lane, () => payload.fill(1));
  if (keepHandle) handles.push(cancel);
  return cancel;
}
for (const lane of ["reveal", "catchup", "maintenance"]) {
  for (let index = 0; index < 64; index++) {
    schedulePayload(lane, cancelled, index % 2 === 0)();
  }
}
const pendingAfterCancel = scheduler.hasPendingWork();
const retained = refs => refs.filter(ref => ref.deref() !== undefined).length;
await setImmediate();
globalThis.gc();
const retainedAfterCancel = retained(cancelled);
const completed = [];
schedulePayload("reveal", completed, true);
frame(0);
const live = [];
schedulePayload("maintenance", live, true);
await setImmediate();
globalThis.gc();
const beforeDispose = {
  cancelled: retainedAfterCancel,
  completed: retained(completed),
  live: retained(live),
};
scheduler.dispose();
await setImmediate();
globalThis.gc();
const afterDispose = retained(live);
for (const cancel of handles) cancel();
process.stdout.write(JSON.stringify({
  pendingAfterCancel, beforeDispose, afterDispose,
  pendingAfterDispose: scheduler.hasPendingWork(),
}));
`,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		pendingAfterCancel: false,
		beforeDispose: { cancelled: 0, completed: 0, live: 1 },
		afterDispose: 0,
		pendingAfterDispose: false,
	});
});
