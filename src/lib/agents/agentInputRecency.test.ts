import { afterEach, describe, expect, it } from "vitest";
import {
	forgetAgentInput,
	lastInputAgentId,
	lastInputAtMs,
	recordAgentInput,
	resetAgentInputRecency,
} from "@/lib/agents/agentInputRecency";

afterEach(resetAgentInputRecency);

describe("agentInputRecency", () => {
	it("처음에는 아무것도 없다", () => {
		expect(lastInputAgentId()).toBeUndefined();
	});

	it("마지막 입력이 이긴다", () => {
		recordAgentInput("a", 100);
		recordAgentInput("b", 200);
		expect(lastInputAgentId()).toBe("b");
		expect(lastInputAtMs()).toBe(200);
	});

	// 없는 에이전트를 기본 대상으로 제시하면 보낸 뒤에야 실패를 알게 된다.
	it("사라진 에이전트 참조를 지운다", () => {
		recordAgentInput("a", 100);
		forgetAgentInput("a");
		expect(lastInputAgentId()).toBeUndefined();
	});

	it("다른 에이전트가 사라진 것은 현재 값을 건드리지 않는다", () => {
		recordAgentInput("a", 100);
		forgetAgentInput("other");
		expect(lastInputAgentId()).toBe("a");
	});
});
