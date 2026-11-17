import { asRecord, hasOnlyKeys } from "@/lib/payloadGuards";

const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;

/** The Session a Run was started from — the spawn request's
 * `plan.request.parent`, the lead's Hmux Session when a lead starts workers
 * with `dure run` from a Dure pane. */
export interface AgentRunParentSessionV1 {
	readonly sessionId: string;
	readonly workspaceId: string;
}

/** Client projection of a Run's parent. `leadAgentId` is the Agent that owned
 * the parent Session when this client first projected the Run, so the link
 * survives the lead being rehosted onto another Session. */
export interface AgentRunParentV1 extends AgentRunParentSessionV1 {
	readonly leadAgentId?: string;
}

function token(value: unknown): value is string {
	return typeof value === "string" && SAFE_TOKEN.test(value);
}

/** The wire shape the CLI sends: exactly the spawn receipt's parent. */
export function parseAgentRunParentSessionV1(
	value: unknown,
): AgentRunParentSessionV1 | undefined {
	const candidate = asRecord(value);
	return candidate &&
		hasOnlyKeys(candidate, ["sessionId", "workspaceId"]) &&
		token(candidate.sessionId) &&
		token(candidate.workspaceId)
		? { sessionId: candidate.sessionId, workspaceId: candidate.workspaceId }
		: undefined;
}

/** The persisted projection. Anything malformed is dropped, which only
 * ungroups the Agent; it never invalidates the Agent record. */
export function parseAgentRunParentV1(
	value: unknown,
): AgentRunParentV1 | undefined {
	const candidate = asRecord(value);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, ["sessionId", "workspaceId", "leadAgentId"]) ||
		!token(candidate.sessionId) ||
		!token(candidate.workspaceId) ||
		(candidate.leadAgentId !== undefined && !token(candidate.leadAgentId))
	) {
		return undefined;
	}
	return {
		sessionId: candidate.sessionId,
		workspaceId: candidate.workspaceId,
		...(candidate.leadAgentId === undefined
			? {}
			: { leadAgentId: candidate.leadAgentId }),
	};
}

/** What lead resolution reads of an Agent. Structural, so `@/types` can name
 * `AgentRunParentV1` without this module depending back on it. */
export interface RunParentedAgent {
	readonly id: string;
	readonly runParent?: AgentRunParentV1;
	readonly runtimeBinding?: AgentRunParentSessionV1;
}

/** One key per parent Session, shared by everything that groups a lead's
 * workers. */
export function agentRunParentKey(parent: AgentRunParentSessionV1): string {
	return `${parent.workspaceId}\u0000${parent.sessionId}`;
}

/** Index the Agents once; resolve each worker's lead against it. A lead is
 * the one other Agent whose runtime binding is the parent Session. When no
 * Agent owns that Session any more (the lead was rehosted), the Agent
 * recorded at first projection stands in. An ambiguous or missing lead
 * resolves to none: the worker stays an ordinary row. */
export function createAgentRunLeadResolver<A extends RunParentedAgent>(
	agents: readonly A[],
): (agent: Pick<RunParentedAgent, "id" | "runParent">) => A | undefined {
	const bySession = new Map<string, A[]>();
	const byId = new Map<string, A>();
	for (const agent of agents) {
		byId.set(agent.id, agent);
		if (!agent.runtimeBinding) continue;
		const key = agentRunParentKey(agent.runtimeBinding);
		const owners = bySession.get(key);
		if (owners) owners.push(agent);
		else bySession.set(key, [agent]);
	}
	return (agent) => {
		const parent = agent.runParent;
		if (!parent) return undefined;
		const owners = (bySession.get(agentRunParentKey(parent)) ?? []).filter(
			(owner) => owner.id !== agent.id,
		);
		if (owners.length > 1) return undefined;
		if (owners.length === 1) return owners[0];
		const recorded =
			parent.leadAgentId === undefined
				? undefined
				: byId.get(parent.leadAgentId);
		return recorded && recorded.id !== agent.id ? recorded : undefined;
	};
}

/** A presentation request's optional `parent`: absent stays absent, and
 * anything present must be exactly a parent Session. */
export function parseRequestedAgentRunParent(
	value: unknown,
	refuse: (message: string) => never,
): AgentRunParentSessionV1 | undefined {
	if (value === undefined) return undefined;
	return parseAgentRunParentSessionV1(value) ?? refuse("parent is invalid");
}

/** The `runParent` of an Agent a Run presents, to spread into it. A parent
 * already recorded stays, so the lead it names survives a later rehost;
 * otherwise the requested Session is recorded with the Agent that owns it in
 * this client now. */
export function presentedAgentRunParent(
	agent: Pick<RunParentedAgent, "id" | "runParent">,
	parent: AgentRunParentSessionV1 | undefined,
	agents: readonly RunParentedAgent[],
): { runParent?: AgentRunParentV1 } {
	if (agent.runParent) return { runParent: agent.runParent };
	if (!parent) return {};
	const lead = createAgentRunLeadResolver(agents)({
		id: agent.id,
		runParent: parent,
	});
	return {
		runParent: lead ? { ...parent, leadAgentId: lead.id } : { ...parent },
	};
}
