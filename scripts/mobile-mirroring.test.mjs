import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import vm from "node:vm";
const context = vm.createContext({});
vm.runInContext(
	readFileSync(
		new URL("../src-tauri/src/mobile_simulator/mirroring.js", import.meta.url),
		"utf8",
	),
	context,
);
const perform = context.performMirroring;
const target = {
	id: "mirroring:42:EKWlAAAAAAA:99",
	pid: 42,
	ready: true,
	bounds: { X: 1, Y: 2, Width: 350, Height: 779 },
};
function desktop(observations = [target]) {
	const sent = [];
	let index = 0;
	return {
		sent,
		inspect: () =>
			structuredClone(observations[Math.min(index++, observations.length - 1)]),
		send: (device, action, check) => {
			check();
			sent.push({ device, action });
		},
	};
}
test("inspection does not dispatch; exact session is required for input", () => {
	const d = desktop();
	assert.equal(perform({}, d).id, target.id);
	assert.equal(d.sent.length, 0);
	assert.throws(
		() =>
			perform(
				{
					id: "mirroring:42:changed:99",
					action: { kind: "button", button: "home" },
				},
				d,
			),
		/session changed/,
	);
	assert.throws(
		() => perform({ action: { kind: "button", button: "home" } }, d),
		/exact/,
	);
	assert.equal(d.sent.length, 0);
});
test("an unavailable connection or failed native inspection never sends input", () => {
	const d = desktop([{ ...target, ready: false }]);
	assert.throws(
		() =>
			perform({ id: target.id, action: { kind: "button", button: "home" } }, d),
		/Connect/,
	);
	assert.equal(d.sent.length, 0);
	assert.throws(
		() =>
			perform(
				{ id: target.id, action: { kind: "button", button: "home" } },
				{
					...d,
					inspect() {
						throw new Error("Accessibility required");
					},
				},
			),
		/Accessibility/,
	);
	assert.equal(d.sent.length, 0);
});
test("unproven touch/text/keys and simulator-only operations fail before native dispatch", () => {
	for (const action of [
		{ kind: "boot" },
		{ kind: "install", path: "/tmp/app.app" },
		{ kind: "launch", appId: "com.example" },
		{ kind: "paste", text: "x" },
		{ kind: "rotate", landscape: true },
		{ kind: "button", button: "back" },
		{ kind: "key", key: "enter" },
		{ kind: "type", text: "Dure" },
		{ kind: "type", text: "한글 😀" },
		{
			kind: "gesture",
			start: { x: 0.3, y: 0.2 },
			end: { x: 0.3, y: 0.2 },
			width: 700,
			height: 1558,
		},
	]) {
		const d = desktop();
		assert.throws(
			() => perform({ id: target.id, action }, d),
			/iPhone Mirroring supports|explicit foreground/,
		);
		assert.equal(d.sent.length, 0);
	}
});
test("replacement and window movement between observation and dispatch fail closed", () => {
	for (const change of [
		{ id: "mirroring:43:other:99" },
		{ ready: false },
		{ bounds: { ...target.bounds, X: 22 } },
	]) {
		const d = desktop([target, { ...target, ...change }]);
		assert.throws(
			() =>
				perform(
					{ id: target.id, action: { kind: "button", button: "home" } },
					d,
				),
			/changed during input/,
		);
		assert.equal(d.sent.length, 0);
	}
});
test("Home and App Switcher retain exact pinned session; no automatic mutation replay", () => {
	for (const button of ["home", "recents"]) {
		const d = desktop();
		perform({ id: target.id, action: { kind: "button", button } }, d);
		assert.equal(d.sent.length, 1);
		assert.equal(d.sent[0].device.id, target.id);
		assert.equal(d.sent[0].action.button, button);
	}
	let attempts = 0;
	assert.throws(
		() =>
			perform(
				{ id: target.id, action: { kind: "button", button: "home" } },
				{
					...desktop(),
					send() {
						attempts++;
						throw new Error("unconfirmed");
					},
				},
			),
		/unconfirmed/,
	);
	assert.equal(attempts, 1);
});

const tap = {
	kind: "gesture",
	start: { x: 0.3, y: 0.2 },
	end: { x: 0.3, y: 0.2 },
	width: 700,
	height: 1558,
	foreground: true,
};
test("foreground tap requires opt-in, fresh geometry and refuses unproven swipe", () => {
	const d = desktop();
	let activations = 0;
	d.foreground = (_, operation) => {
		activations++;
		operation(() => {});
	};
	assert.throws(
		() =>
			perform(
				{
					id: target.id,
					action: { ...tap, foreground: false },
					frameBounds: target.bounds,
				},
				d,
			),
		/explicit foreground/,
	);
	assert.throws(
		() =>
			perform(
				{
					id: target.id,
					action: tap,
					frameBounds: { ...target.bounds, Width: 400 },
				},
				d,
			),
		/view changed/,
	);
	assert.throws(
		() =>
			perform(
				{
					id: target.id,
					action: { ...tap, end: { x: 0.3, y: 0.8 } },
					frameBounds: target.bounds,
				},
				d,
			),
		/swipes/,
	);
	assert.equal(activations, 0);
	assert.equal(d.sent.length, 0);
	perform({ id: target.id, action: tap, frameBounds: target.bounds }, d);
	assert.equal(activations, 1);
	assert.equal(d.sent.length, 1);
});
function focusFixture() {
	const selected = { pid: 42, generation: "EKWlAAAAAAA" },
		previous = { pid: 10, generation: "previous" };
	let front = previous,
		clock = 0;
	const activations = [],
		restored = [];
	const d = {
		process: (pid) => (pid === 42 ? selected : previous),
		frontmost: () => front,
		activate: (app) => {
			activations.push(app);
			front = app;
			return true;
		},
		pointer: () => ({ x: 10, y: 20 }),
		restorePointer: (point) => restored.push(point),
		now: () => clock,
		wait: (ms) => {
			clock += ms;
		},
	};
	return {
		d,
		selected,
		previous,
		activations,
		restored,
		setFront: (app) => {
			front = app;
		},
	};
}
test("foreground tap restores only the observed previous process and pointer", () => {
	const f = focusFixture();
	let sent = 0;
	context.withMirroringForeground(target, f.d, (check) => {
		check();
		sent++;
	});
	assert.equal(sent, 1);
	assert.deepEqual(f.activations, [f.selected, f.previous]);
	assert.equal(f.restored.length, 1);
});
test("user focus switch stops input and is never overridden during restoration", () => {
	const f = focusFixture();
	assert.throws(
		() =>
			context.withMirroringForeground(target, f.d, (check) => {
				f.setFront({ pid: 99, generation: "user" });
				check();
			}),
		/lost foreground/,
	);
	assert.deepEqual(f.activations, [f.selected]);
	assert.equal(f.restored.length, 0);
});
test("replacement prior process and failed activation never receive restored focus", () => {
	const f = focusFixture();
	context.withMirroringForeground(target, f.d, () => {
		f.d.process = (pid) =>
			pid === 42 ? f.selected : { pid: 10, generation: "replacement" };
	});
	assert.deepEqual(f.activations, [f.selected]);
	assert.equal(f.restored.length, 0);
	const timeout = focusFixture();
	let sent = 0;
	timeout.d.activate = () => true;
	assert.throws(
		() => context.withMirroringForeground(target, timeout.d, () => sent++),
		/timed out/,
	);
	assert.equal(sent, 0);
	assert.equal(timeout.restored.length, 0);
});
test("uncertain tap failure is not replayed and restores focus when still owned", () => {
	const f = focusFixture();
	let attempts = 0;
	assert.throws(
		() =>
			context.withMirroringForeground(target, f.d, () => {
				attempts++;
				throw new Error("unconfirmed");
			}),
		/unconfirmed/,
	);
	assert.equal(attempts, 1);
	assert.deepEqual(f.activations, [f.selected, f.previous]);
});
