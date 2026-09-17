import { describe, expect, it } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";
import type { SshState } from "@/types";
import {
	createSessionRuntimeStoreSlice,
	hasSessionAgentRuntimeObservation,
} from "./sessionRuntimeStoreSlice";

/** Minimal host harness — applies updater patches the way zustand's set does
 *  and counts identity-return no-ops, which the slice uses to skip listener
 *  notification on unchanged polling writes. */
function harness() {
	const slice = createSessionRuntimeStoreSlice((updater) => {
		const next = updater(host.state);
		if (next === host.state) {
			host.noops += 1;
			return;
		}
		host.state = { ...host.state, ...next };
	});
	const host = {
		noops: 0,
		state: { ...slice, sshStates: {}, sshMessages: {} } as ReturnType<
			typeof createSessionRuntimeStoreSlice
		> & {
			sshStates: Record<string, SshState>;
			sshMessages: Record<string, string>;
		},
	};
	return host;
}

const runtimeState = (
	terminalEpoch: string,
	revision: string,
): HmuxAgentRuntimeState =>
	({ terminalEpoch, revision }) as HmuxAgentRuntimeState;

describe("sessionRuntimeStoreSlice", () => {
	it("keeps a current observer when a peer disconnects and restores an equal-revision snapshot", () => {
		const host = harness();
		const observed = () =>
			hasSessionAgentRuntimeObservation(
				host.state.sessionAgentRuntimeState.s1,
				host.state.sessionAgentRuntimeObservers.s1,
			);
		const background = host.state.beginSessionAgentRuntimeObservation("s1");
		expect(observed()).toBe(false);
		const snapshot = runtimeState("e1", "5");
		background.publish(snapshot);
		const pane = host.state.beginSessionAgentRuntimeObservation("s1");
		pane.publish(snapshot);
		background.dispose();
		expect(observed()).toBe(true);
		pane.dispose();
		expect(observed()).toBe(false);
		expect(host.state.sessionAgentRuntimeState.s1).toBe(snapshot);
		const reconnected = host.state.beginSessionAgentRuntimeObservation("s1");
		reconnected.publish({ ...snapshot });
		expect(observed()).toBe(true);
		expect(host.state.sessionAgentRuntimeState.s1).toBe(snapshot);
		background.dispose();
		background.publish(runtimeState("old", "99"));
		expect(observed()).toBe(true);
		expect(host.state.sessionAgentRuntimeState.s1).toBe(snapshot);
	});

	it("does not substantiate a newer Host with an older observer or resurrect forgotten runtime", () => {
		const host = harness();
		const old = host.state.beginSessionAgentRuntimeObservation("s1");
		old.publish(runtimeState("e1", "5"));
		host.state.setSessionAgentRuntimeState("s1", runtimeState("e2", "1"));
		old.publish(runtimeState("e1", "99"));
		expect(host.state.sessionAgentRuntimeState.s1.terminalEpoch).toBe("e2");
		expect(
			hasSessionAgentRuntimeObservation(
				host.state.sessionAgentRuntimeState.s1,
				host.state.sessionAgentRuntimeObservers.s1,
			),
		).toBe(false);
		host.state.forgetSessionRuntime(["s1"]);
		old.publish(runtimeState("e1", "6"));
		old.dispose();
		expect(host.state.sessionAgentRuntimeState.s1).toBeUndefined();
		expect(host.state.sessionAgentRuntimeObservers.s1).toBeUndefined();
	});

	it("does not invent an activity timestamp when a hook supplies only prompt text", () => {
		const host = harness();
		host.state.setSessionActivity("native", "Prompt restored on reconnect");
		expect(host.state.sessionActivity.native.at).toBeUndefined();
		host.state.setSessionActivity("native", "Actual provider work", 100);
		host.state.setSessionActivity("native", "Different presentation text");
		expect(host.state.sessionActivity.native.at).toBe(100);
	});

	it("preserves provider time on replay and advances unchanged prompts on new activity", () => {
		const host = harness();
		host.state.setSessionActivity("chat", "Review", 100);
		host.state.setSessionActivity("chat", "Review", 200);
		expect(host.state.sessionActivity.chat).toEqual({
			text: "Review",
			at: 200,
		});
		const latest = host.state.sessionActivity.chat;
		host.state.setSessionActivity("chat", "Old prompt", 150);
		host.state.setSessionActivity("chat", "Review", 200);
		expect(host.state.sessionActivity.chat).toBe(latest);
		host.state.setSessionActivity("chat", "", 300);
		expect(host.state.sessionActivity.chat).toEqual({
			text: "Review",
			at: 300,
		});
	});

	it("keeps the human prompt when internal task notifications arrive or replay", () => {
		const host = harness();
		host.state.setSessionActivity("s1", "Analyze the image", 100);
		const notification = "<task-notification><task-id>b3jd014iq</task-id><status>completed</status></task-notification>";
		host.state.setSessionActivity("s1", notification);
		expect(host.state.sessionActivity.s1).toEqual({ text: "Analyze the image", at: 100 });
		host.state.setSessionActivity("s1", notification, 200);
		expect(host.state.sessionActivity.s1).toEqual({ text: "Analyze the image", at: 200 });
	});
	it("같은 활동 값의 재기록은 state 자신을 반환한다 (리스너 통지 생략)", () => {
		const host = harness();
		host.state.setAgentActivity("a1", "working");
		host.state.setAgentActivity("a1", "working");
		expect(host.noops).toBe(1);
		expect(host.state.agentActivity.a1).toBe("working");
	});

	it("changing provider title frames normalize before listener notification", () => {
		const host = harness();
		host.state.setSessionTitle("s1", "⠋ terminal-parsing");
		const titles = host.state.sessionTitle;
		host.state.setSessionTitle("s1", "⠙ terminal-parsing");

		expect(host.noops).toBe(1);
		expect(host.state.sessionTitle).toBe(titles);
		expect(host.state.sessionTitle.s1).toBe("terminal-parsing");
	});

	it("에이전트 런타임 상태는 같은 epoch에서 revision 역행을 거부한다", () => {
		const host = harness();
		host.state.setSessionAgentRuntimeState("s1", runtimeState("e1", "5"));
		host.state.setSessionAgentRuntimeState("s1", runtimeState("e1", "4"));
		expect(host.state.sessionAgentRuntimeState.s1.revision).toBe("5");
		// epoch가 바뀌면 revision 비교 없이 새 세대가 이긴다.
		host.state.setSessionAgentRuntimeState("s1", runtimeState("e2", "1"));
		expect(host.state.sessionAgentRuntimeState.s1.revision).toBe("1");
	});

	it("forgetSessionRuntime은 세션별 SSH 기록까지 지우고 다른 세션은 남긴다", () => {
		const host = harness();
		host.state.setSessionCwd("gone", "/a");
		host.state.setSessionCwd("kept", "/b");
		host.state.sshStates = { gone: "connected", kept: "connected" };
		host.state.forgetSessionRuntime(["gone"]);
		expect(host.state.sessionCwd).toEqual({ kept: "/b" });
		expect(host.state.sshStates).toEqual({ kept: "connected" });
	});

	it("provider 핀은 null로 해제되고 같은 값 재기록은 no-op이다", () => {
		const host = harness();
		host.state.setSessionAgentPin("s1", "codex");
		host.state.setSessionAgentPin("s1", "codex");
		expect(host.noops).toBe(1);
		host.state.setSessionAgentPin("s1", null);
		expect("s1" in host.state.sessionAgentPin).toBe(false);
	});

	it("singular Hmux metadata writes retain their exact no-op semantics", () => {
		const host = harness();
		const session = hmuxSessionSummaryFixture({
			workspaceId: "workspace",
			sessionId: "session",
		});
		host.state.setHmuxSessionMetadata(session);
		const metadata = host.state.hmuxSessionMetadata;
		const key = hmuxSessionMetadataKey("workspace", "session");
		const entry = metadata[key];

		host.state.setHmuxSessionMetadata({ ...session });

		expect(host.noops).toBe(1);
		expect(host.state.hmuxSessionMetadata).toBe(metadata);
		expect(host.state.hmuxSessionMetadata[key]).toBe(entry);
	});

	it("빈 활동 텍스트와 동일 텍스트 재기록은 레코드를 만들지 않는다", () => {
		const host = harness();
		host.state.setSessionActivity("s1", "   ");
		expect(host.state.sessionActivity).toEqual({});
		host.state.setSessionActivity("s1", "fix tests");
		const first = host.state.sessionActivity.s1;
		host.state.setSessionActivity("s1", "fix tests");
		expect(host.state.sessionActivity.s1).toBe(first);
	});
});
