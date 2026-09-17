import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import {
	type AgentDiffStat,
	agentDiffStat,
	gitStatus,
	hostToOpts,
	sshExecOnce,
} from "@/lib/ipc";
import { shellQuote } from "@/lib/platform/shell";
import { badgeFromStat, type DiffBadge } from "@/lib/scm/status/diffBadges";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import {
	type GitPollTier,
	gitDiffBadgePollDue,
	mergeGitPollTier,
	seedNewGitPollTargets,
	selectGitPollTarget,
} from "@/lib/scm/status/gitPollingPolicy";
import {
	parseRemoteDiffStat,
	remoteDiffStatCommand,
} from "@/lib/scm/status/remoteDiffStat";
import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";
import type { Agent, GitStatus, SshHostConfig } from "@/types";

const POLL_TICK_MS = 5_000;
/** Keep advisory git work out of the first-paint / terminal-stabilization lane. */
const DESKTOP_TRANSITION_QUIET_MS = 10_000;

interface LocalPollTarget {
	key: string;
	tier: GitPollTier;
	/** 이 워크트리의 브랜치를 아직 아무도 모른다 — `seedNewGitPollTargets` 참고. */
	branchUnknown: boolean;
	kind: "local";
	path: string;
	agentIds: string[];
}

interface RemotePollTarget {
	key: string;
	tier: GitPollTier;
	branchUnknown: boolean;
	kind: "remote";
	path: string;
	host?: SshHostConfig;
	agentIds: string[];
}

type PollTarget = LocalPollTarget | RemotePollTarget;

function visibleAgentContext() {
	const state = useStore.getState();
	const api = getDockview(state.activeSpaceId);
	const panels =
		api?.panels.map(dockPanelReference) ??
		panelsFromLayout(state.layouts[state.activeSpaceId]);
	const activeAgentIds = new Set<string>();
	for (const panel of panels) {
		const agentId = agentIdFromPane(panel);
		if (agentId) activeAgentIds.add(agentId);
	}
	const activePanel = api?.activePanel;
	const focusedAgentId = activePanel
		? (agentIdFromPane(dockPanelReference(activePanel)) ?? null)
		: null;
	return { activeAgentIds, focusedAgentId };
}

function tierForAgent(
	agentId: string,
	activeAgentIds: ReadonlySet<string>,
	focusedAgentId: string | null,
): GitPollTier {
	if (agentId === focusedAgentId) return "focused";
	if (activeAgentIds.has(agentId)) return "active";
	return "background";
}

function collectPollTargets(): PollTarget[] {
	const state = useStore.getState();
	const { activeAgentIds, focusedAgentId } = visibleAgentContext();
	const targets = new Map<string, PollTarget>();
	for (const agent of state.agents) {
		const tier = tierForAgent(agent.id, activeAgentIds, focusedAgentId);
		// 폴러도 에이전트 레코드도 이 워크트리의 브랜치를 모른다. 기존 체크아웃에
		// 만든 에이전트가 그렇고(`branch: ""` 로 등록되고 다시 안 고쳐진다), 그
		// 브랜치는 폰과 사이드바에서 그 세션을 부르는 유일한 이름이다.
		const branchUnknown = !(
			state.gitStatuses[agent.id]?.branch?.trim() || agent.branch?.trim()
		);
		const binding = bindingForAgent(agent, state.projects);
		const remote = binding?.source === "ssh";
		const host = remote
			? state.sshHosts.find((candidate) => candidate.id === binding.hostId)
			: undefined;
		const key = remote
			? `remote:${host?.id ?? `missing:${agent.projectId}`}:${agent.worktreePath}`
			: `local:${agent.worktreePath}`;
		const existing = targets.get(key);
		if (existing) {
			existing.tier = mergeGitPollTier(existing.tier, tier);
			existing.branchUnknown ||= branchUnknown;
			existing.agentIds.push(agent.id);
			continue;
		}
		targets.set(
			key,
			remote
				? {
						key,
						tier,
						branchUnknown,
						kind: "remote",
						path: agent.worktreePath,
						host,
						agentIds: [agent.id],
					}
				: {
						key,
						tier,
						branchUnknown,
						kind: "local",
						path: agent.worktreePath,
						agentIds: [agent.id],
					},
		);
	}
	return [...targets.values()];
}

function parsePorcelain(out: string): GitStatus {
	const status: GitStatus = {
		isRepo: true,
		branch: "",
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
	};
	for (const line of out.split("\n")) {
		if (line.startsWith("# branch.head "))
			status.branch = line.slice(14).trim();
		else if (line.startsWith("# branch.ab ")) {
			for (const part of line.slice(12).split(" ")) {
				if (part.startsWith("+"))
					status.ahead = Number.parseInt(part.slice(1), 10) || 0;
				if (part.startsWith("-"))
					status.behind = Number.parseInt(part.slice(1), 10) || 0;
			}
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.split(" ")[1] ?? "..";
			if (xy[0] !== ".") status.staged++;
			if (xy[1] !== ".") status.unstaged++;
		} else if (line.startsWith("? ")) status.untracked++;
		else if (line.startsWith("u ")) status.unstaged++;
	}
	return status;
}

function currentAgents(target: PollTarget): Agent[] {
	const ids = new Set(target.agentIds);
	return useStore
		.getState()
		.agents.filter(
			(agent) => ids.has(agent.id) && agent.worktreePath === target.path,
		);
}

function updateStatus(target: PollTarget, status: GitStatus) {
	const state = useStore.getState();
	for (const agent of currentAgents(target))
		state.setGitStatus(agent.id, status);
}

function updateStatusError(target: PollTarget, error: unknown) {
	const state = useStore.getState();
	for (const agent of currentAgents(target))
		state.setGitStatusError(agent.id, String(error));
}

function pruneTransientAgentState() {
	const agents = useStore.getState().agents;
	const agentIds = new Set(agents.map((agent) => agent.id));
	useDiffBadges.getState().prune(agentIds);
	useAgentAttention
		.getState()
		.prune(new Set(agents.map((agent) => agent.sessionId)), agentIds);
}

export function startGitStatusPoller(): () => void {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let quietUntil = performance.now() + DESKTOP_TRANSITION_QUIET_MS;
	const lastPolledAt = new Map<string, number>();
	const lastDiffPolledAt = new Map<string, number>();

	const schedule = (delayMs = POLL_TICK_MS) => {
		clearTimeout(timer);
		if (!stopped) timer = setTimeout(() => void poll(), delayMs);
	};

	const heavyWorkAllowed = () =>
		!stopped &&
		document.visibilityState !== "hidden" &&
		performance.now() >= quietUntil;

	/** The fork-point diff is far more expensive than `git status`, so it runs
	 * on its own slower cadence after the status read, for both worktree kinds. */
	const pollDiffBadge = async (
		target: PollTarget,
		now: number,
		observe: () => Promise<AgentDiffStat>,
	) => {
		// A desktop switch may have happened while git status was in flight. Do
		// not start the much more expensive fork-point diff inside its quiet lane.
		if (!heavyWorkAllowed()) return;
		if (!gitDiffBadgePollDue(target, lastDiffPolledAt, now)) return;
		lastDiffPolledAt.set(target.key, now);
		let badge: DiffBadge | null;
		try {
			badge = badgeFromStat(await observe());
		} catch {
			badge = null;
		}
		for (const agent of currentAgents(target)) {
			useDiffBadges.getState().setBadge(agent.id, badge);
		}
	};

	const pollLocal = async (target: LocalPollTarget, now: number) => {
		try {
			updateStatus(target, await gitStatus(target.path));
		} catch (error) {
			updateStatusError(target, error);
		}
		await pollDiffBadge(target, now, () => agentDiffStat(target.path));
	};

	const remoteExec = async (
		host: SshHostConfig,
		command: string,
		label: string,
	) => {
		const result = await sshExecOnce(hostToOpts(host), command);
		if (result.code !== 0) {
			throw new Error(
				(result.stderr || result.stdout).trim() ||
					`${label} exit ${result.code}`,
			);
		}
		return result.stdout;
	};

	const pollRemote = async (target: RemotePollTarget, now: number) => {
		const host = target.host;
		if (!host) {
			updateStatusError(target, new Error(t("common.sshHostNotFound")));
			return;
		}
		try {
			const stdout = await remoteExec(
				host,
				`git --no-optional-locks -C ${shellQuote(target.path)} status --porcelain=v2 --branch`,
				"git status",
			);
			updateStatus(target, parsePorcelain(stdout));
		} catch (error) {
			updateStatusError(target, error);
			// Every exec opens a fresh connection and the poller lane is
			// serialized: an unreachable host must not cost a second timeout.
			return;
		}
		await pollDiffBadge(target, now, async () =>
			parseRemoteDiffStat(
				await remoteExec(host, remoteDiffStatCommand(target.path), "git diff"),
			),
		);
	};

	const poll = async () => {
		if (stopped || running) return;
		if (document.visibilityState === "hidden") {
			schedule(DESKTOP_TRANSITION_QUIET_MS);
			return;
		}
		const now = performance.now();
		if (now < quietUntil) {
			schedule(Math.max(POLL_TICK_MS, quietUntil - now));
			return;
		}
		const targets = collectPollTargets();
		const liveKeys = new Set(targets.map((target) => target.key));
		for (const key of lastPolledAt.keys()) {
			if (!liveKeys.has(key)) {
				lastPolledAt.delete(key);
				lastDiffPolledAt.delete(key);
			}
		}
		seedNewGitPollTargets(targets, lastPolledAt, now);
		const target = selectGitPollTarget(targets, lastPolledAt, now);
		pruneTransientAgentState();
		if (!target) {
			schedule();
			return;
		}

		running = true;
		lastPolledAt.set(target.key, now);
		try {
			if (target.kind === "local") await pollLocal(target, now);
			else await pollRemote(target, now);
		} finally {
			running = false;
			schedule();
		}
	};

	const postponeForPresentation = () => {
		quietUntil = performance.now() + DESKTOP_TRANSITION_QUIET_MS;
		if (!running) schedule(DESKTOP_TRANSITION_QUIET_MS);
	};
	const unsubscribe = useStore.subscribe((state, previous) => {
		if (state.activeSpaceId !== previous.activeSpaceId)
			postponeForPresentation();
	});
	const onVisibilityChange = () => {
		if (document.visibilityState !== "hidden") postponeForPresentation();
	};
	document.addEventListener("visibilitychange", onVisibilityChange);
	schedule(DESKTOP_TRANSITION_QUIET_MS);

	return () => {
		stopped = true;
		clearTimeout(timer);
		unsubscribe();
		document.removeEventListener("visibilitychange", onVisibilityChange);
	};
}
