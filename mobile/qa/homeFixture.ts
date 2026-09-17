import type { CensusModel } from "../src/censusView";
import type { HubProbeSession } from "../src/ipc";
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
	};
}
