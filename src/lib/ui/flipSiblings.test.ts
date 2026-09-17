// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	playSiblingFlip,
	snapshotFollowingSiblings,
} from "@/lib/ui/flipSiblings";

function el(tag: string, id: string, top: number) {
	const node = document.createElement(tag);
	node.id = id;
	node.getBoundingClientRect = () =>
		({ top, bottom: top + 10, height: 10, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
	return node;
}

describe("snapshotFollowingSiblings", () => {
	it("records the movers at every level up to the root, never the ones before", () => {
		const root = el("div", "root", 0);
		const spaceA = el("section", "spaceA", 0);
		const spaceB = el("section", "spaceB", 100);
		const trailing = el("section", "trailing", 200);
		root.append(spaceA, spaceB, trailing);
		const groupBefore = el("section", "groupBefore", 0);
		const toggled = el("section", "toggled", 20);
		const groupAfter = el("section", "groupAfter", 60);
		spaceA.append(groupBefore, toggled, groupAfter);

		const positions = snapshotFollowingSiblings(toggled, root);

		expect([...positions.keys()].map((node) => node.id)).toEqual([
			"groupAfter",
			"spaceB",
			"trailing",
		]);
		expect(positions.get(spaceB)).toBe(100);
	});
});

describe("playSiblingFlip", () => {
	it("plays each element from its old top to its new one and skips the still", () => {
		const moved = el("section", "moved", 100);
		const still = el("section", "still", 300);
		const gone = el("section", "gone", 400);
		document.body.append(moved, still);
		const before = new Map<Element, number>([
			[moved, 60],
			[still, 300],
			[gone, 400],
		]);
		const animate = vi.fn();
		moved.animate = animate;
		still.animate = animate;

		const played = playSiblingFlip(before, { durationMs: 200, easing: "ease-out" });

		expect(played).toBe(1);
		expect(animate).toHaveBeenCalledOnce();
		expect(animate).toHaveBeenCalledWith(
			[{ transform: "translateY(-40px)" }, { transform: "translateY(0)" }],
			{ duration: 200, easing: "ease-out" },
		);
		moved.remove();
		still.remove();
	});
});
