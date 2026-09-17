import { describe, expect, it } from "vitest";
import { chooseAgentTarget } from "@/lib/design/designModeTarget";

const agent = (id: string) => ({ id, name: id, provider: "claude" });

describe("chooseAgentTarget", () => {
	it("후보가 없으면 기본 선택도 없다", () => {
		const choice = chooseAgentTarget({ candidates: [] });
		expect(choice.defaultId).toBeUndefined();
		expect(choice.reason).toBe("none");
	});

	// 활성 pane이 아니라 대화하던 에이전트가 기본값이다.
	it("마지막으로 입력한 에이전트를 기본으로 고른다", () => {
		const choice = chooseAgentTarget({
			candidates: [agent("a"), agent("b"), agent("c")],
			lastInputAgentId: "b",
		});
		expect(choice.defaultId).toBe("b");
		expect(choice.reason).toBe("last_input");
	});

	// 그 에이전트를 닫았을 수 있다 — 없는 대상을 기본으로 제시하면 보낸 뒤에야
	// 실패를 알게 된다.
	it("마지막 입력 에이전트가 후보에 없으면 다른 것으로 넘어간다", () => {
		const choice = chooseAgentTarget({
			candidates: [agent("a"), agent("b")],
			lastInputAgentId: "gone",
		});
		expect(choice.defaultId).toBe("a");
		expect(choice.reason).toBe("first_candidate");
	});

	it("후보가 하나면 그것이 답이고 근거도 그렇게 말한다", () => {
		const choice = chooseAgentTarget({ candidates: [agent("solo")] });
		expect(choice.defaultId).toBe("solo");
		expect(choice.reason).toBe("only_candidate");
	});

	// 근거가 약한 선택을 강조하지 않으면 잘못된 pane으로 조용히 보내게 된다.
	it("근거 없이 첫 항목을 고른 경우를 구분해 알린다", () => {
		expect(
			chooseAgentTarget({ candidates: [agent("a"), agent("b")] }).reason,
		).toBe("first_candidate");
	});

	it("후보 목록을 그대로 돌려준다 — UI가 선택지를 보여야 한다", () => {
		const choice = chooseAgentTarget({
			candidates: [agent("a"), agent("b")],
			lastInputAgentId: "a",
		});
		expect(choice.candidates.map((c) => c.id)).toEqual(["a", "b"]);
	});
});
