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

/** How a Run parent names a lead: `session` is the Agent bound to the parent
 * Session now, `recorded` the Agent that owned it when this client first
 * projected the Run. */
export interface AgentRunLead<A> {
	readonly lead: A;
	readonly by: "session" | "recorded";
}

/** Index the Agents once; list each worker's leads against it, most direct
 * first. A lead is the one other Agent whose runtime binding is the parent
 * Session; the Agent recorded at first projection follows, so the link
 * survives the lead being rehosted. A Session two other Agents claim names
 * no lead at all: which of them started the worker is unknown. */
export function createAgentRunLeadsResolver<A extends RunParentedAgent>(
	agents: readonly A[],
): (agent: Pick<RunParentedAgent, "id" | "runParent">) => readonly AgentRunLead<A>[] {
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
		if (!parent) return [];
		const owners = (bySession.get(agentRunParentKey(parent)) ?? []).filter(
			(owner) => owner.id !== agent.id,
		);
		if (owners.length > 1) return [];
		const leads: AgentRunLead<A>[] = owners.map((lead) => ({
			lead,
			by: "session",
		}));
		const recorded =
			parent.leadAgentId === undefined
				? undefined
				: byId.get(parent.leadAgentId);
		if (recorded && recorded.id !== agent.id && recorded !== owners[0]) {
			leads.push({ lead: recorded, by: "recorded" });
		}
		return leads;
	};
}

/** Each worker's most direct lead, or none: the worker stays an ordinary
 * row. */
export function createAgentRunLeadResolver<A extends RunParentedAgent>(
	agents: readonly A[],
): (agent: Pick<RunParentedAgent, "id" | "runParent">) => A | undefined {
	const leadsOf = createAgentRunLeadsResolver(agents);
	return (agent) => leadsOf(agent)[0]?.lead;
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
