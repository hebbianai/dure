import { describe, expect, it } from "vitest";
import { sweepFleet } from "@/lib/hub/fleetHmuxCurrencySweep";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const settle = async () => {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("sweepFleet", () => {
	it("visits several boxes at once, bounded by the concurrency", async () => {
		const gates = new Map<string, ReturnType<typeof deferred>>();
		const started: string[] = [];
		const sweep = sweepFleet(
			["a", "b", "c", "d", "e"],
			async (box) => {
				started.push(box);
				const gate = deferred();
				gates.set(box, gate);
				await gate.promise;
			},
			{ concurrency: 3, isCurrent: () => true },
		);
		await settle();
		expect(started).toEqual(["a", "b", "c"]);

		gates.get("b")?.resolve();
		await settle();
		expect(started).toEqual(["a", "b", "c", "d"]);

		for (const box of ["a", "c", "d"]) gates.get(box)?.resolve();
		await settle();
		expect(started).toEqual(["a", "b", "c", "d", "e"]);
		gates.get("e")?.resolve();
		await sweep;
	});

	it("does not let one unreachable box stop the others", async () => {
		const visited: string[] = [];
		await sweepFleet(
			["down", "up-1", "up-2"],
			async (box) => {
				visited.push(box);
				if (box === "down") throw new Error("connect timed out");
			},
			{ concurrency: 2, isCurrent: () => true },
		);
		expect(visited).toEqual(["down", "up-1", "up-2"]);
	});

	it("stops taking boxes once the pass is stale", async () => {
		let current = true;
		const visited: string[] = [];
		await sweepFleet(
			["a", "b", "c"],
			async (box) => {
				visited.push(box);
				current = false;
			},
			{ concurrency: 1, isCurrent: () => current },
		);
		expect(visited).toEqual(["a"]);
	});
});
