import type { CensusModel } from "../src/censusView";
import type { HubProbeSession } from "../src/ipc";
import { queueKey } from "../src/chatQueue";
import { loadHomeViewOptions } from "../src/homeViewPreferences";

const names = [
	"계속 진행해",
	"Inspect attached image",
	"Figma 디자인대로 UI 구현하기",
	"fix uiux",
	"개선된 frontend 아키텍처 구현",
	"orca browser cli 연결하기",
];
const sessions: HubProbeSession[] = Array.from({ length: 40 }, (_, index) => ({
	session_id: `qa-${index}`,
	session_name: names[index % names.length],
	workspace_id: "qa",
	session_class: "standalone",
	lifecycle: "ready",
	provider_id: ["codex", "claude", "pi", "kimi"][index % 4],
	runner_principal: "qa",
	runner_instance: "i",
	channel_epoch: "e",
	host_instance_id: "h",
	terminal_epoch: "t",
	capabilities: [],
	ready: true,
	box_id: "this-laptop",
	box_label: "QA Mac",
	presentation: {
		pinned: index === 12 || index === 36,
		projectId: index % 2 ? "p1" : "p2",
		projectName: index % 2 ? "Dure" : "Website",
		kind: "agent",
		provider: ["codex", "claude", "pi", "kimi"][index % 4],
		cwd: `/qa/project-${index % 2}`,
		detail:
			index % 2
				? "worktree/fix-uiux"
				: "현재 저장소의 아키텍처를 확인하고 있어요",
		activityAt: Date.now() - (index + 1) * 180_000,
		displayState:
			index < 3 ? "waiting" : index % 5 === 0 ? "blocked" : "working",
		git: {
			worktree: index % 3 ? 0 : 51,
			committed: 0,
			ahead: 0,
			behind: index % 3 ? 6 : 0,
		},
	},
}));
// One session the computer answers for but cannot attach: it stands under the
// "연결할 수 없음" heading at the end of the list, the way the phone shows it.
sessions[6] = { ...sessions[6], ready: false, lifecycle: "exited" };
// Needs you: an approval the computer carried and answers from the phone, and
// an agent waiting for an answer. The other blocked rows wait without content.
sessions[5] = {
	...sessions[5],
	approval_answer: true,
	presentation: {
		...sessions[5].presentation,
		approval: {
			attentionId: "qa-approval",
			request: {
				toolName: "Bash",
				summary: "pnpm --dir mobile test -- src/homeNeedsYou.test.ts",
				choices: ["approve", "approve_always", "deny"],
			},
		},
	},
};
sessions[8] = {
	...sessions[8],
	presentation: { ...sessions[8].presentation, displayState: "input" },
};
// Recently finished: the three idle agents serve their conversation; two have
// an answer, so two cards stand and the third stays in the list only.
for (const index of [0, 1, 2])
	sessions[index] = { ...sessions[index], conversation: true };
const finishedAnswers = {
	[queueKey("qa", "this-laptop", "qa", "qa-0")]:
		"Shipped the Recently finished section; 1195 mobile tests pass.",
	[queueKey("qa", "this-laptop", "qa", "qa-1")]:
		"The flaky test was a timing race in the census loop, now fixed and covered by a regression test that waits for the second catalog read.",
};
export function createHomeFixture(): CensusModel {
	return {
		census: [],
		hubs: [{ hubId: "qa", hubLabel: "QA Mac", reachable: true, sessions }],
		failures: [],
		busy: false,
		emptyMessage: "",
		layout: {
			desktop_order: ["Dure", "Personal"],
			placements: Object.fromEntries(
				sessions.map((row, index) => [
					row.session_id,
					{
						desktop: index < 35 ? "Dure" : "Personal",
						project: index % 2 ? "Dure" : "Website",
						order: index,
						branch: index % 3 ? "agent/codex-15" : "terminal-parsing",
					},
				]),
			),
		},
		viewOptions: loadHomeViewOptions(),
		finishedAnswers,
	};
}
