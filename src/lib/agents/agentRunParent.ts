import { asRecord, hasOnlyKeys } from "@/lib/payloadGuards";

const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;

/** The Session a Run was started from — the spawn request's
 * `plan.request.parent`, the lead's Hmux Session when a lead starts workers
 * with `dure run` from a Dure pane. */
export interface AgentRunParentSessionV1 {
	readonly sessionId: string;
	readonly workspaceId: string;
}

/** The Agent a Run was started from when that agent has no terminal Session
 * of its own — the spawn request's `plan.request.parentAgent`, a Chat agent
 * that started workers with `dure run` from its tool shell. */
interface AgentRunParentAgentV1 {
	readonly agentId: string;
}

/** A Run's parent as a presentation request carries it: the exact Session
 * it was started from, or the Agent when it has none. */
export type AgentRunParentRefV1 = AgentRunParentSessionV1 | AgentRunParentAgentV1;

/** Client projection of a Run's parent. For a Session parent, `leadAgentId`
 * is the Agent that owned the parent Session when this client first projected
 * the Run, so the link survives the lead being rehosted onto another
 * Session. An Agent parent names its lead directly. */
export type AgentRunParentV1 =
	| (AgentRunParentSessionV1 & { readonly leadAgentId?: string })
	| AgentRunParentAgentV1;

function token(value: unknown): value is string {
	return typeof value === "string" && SAFE_TOKEN.test(value);
}

export function isAgentRunParentAgent(
	parent: AgentRunParentRefV1 | AgentRunParentV1,
): parent is AgentRunParentAgentV1 {
	return "agentId" in parent;
}

/** The wire and persisted shape of an Agent parent: exactly `{ agentId }`. */
function parseAgentRunParentAgentV1(
	value: unknown,
): AgentRunParentAgentV1 | undefined {
	const candidate = asRecord(value);
	return candidate &&
		hasOnlyKeys(candidate, ["agentId"]) &&
		token(candidate.agentId)
		? { agentId: candidate.agentId }
		: undefined;
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
	const agent = parseAgentRunParentAgentV1(value);
	if (agent) return agent;
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

/** One key per parent Session or parent Agent, shared by everything that
 * groups a lead's workers. A Session key starts with its non-empty workspace
 * token, so an Agent key, which starts with the separator, never equals one. */
export function agentRunParentKey(parent: AgentRunParentRefV1): string {
	return isAgentRunParentAgent(parent)
		? `\u0000${parent.agentId}`
		: `${parent.workspaceId}\u0000${parent.sessionId}`;
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
 * no lead at all: which of them started the worker is unknown. An Agent
 * parent names its manager directly, and the relation facts read it as it is
 * (agentRelationFacts.ts), so it lists no Session leads here. */
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
		if (!parent || isAgentRunParentAgent(parent)) return [];
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

/** Each worker's most direct Session lead, or none. */
export function createAgentRunLeadResolver<A extends RunParentedAgent>(
	agents: readonly A[],
): (agent: Pick<RunParentedAgent, "id" | "runParent">) => A | undefined {
	const leadsOf = createAgentRunLeadsResolver(agents);
	return (agent) => leadsOf(agent)[0]?.lead;
}

/** A presentation request's optional `parent`: absent stays absent, and
 * anything present must be exactly a parent Session or a parent Agent. */
export function parseRequestedAgentRunParent(
	value: unknown,
	refuse: (message: string) => never,
): AgentRunParentRefV1 | undefined {
	if (value === undefined) return undefined;
	return (
		parseAgentRunParentSessionV1(value) ??
		parseAgentRunParentAgentV1(value) ??
		refuse("parent is invalid")
	);
}

/** The `runParent` of an Agent a Run presents, to spread into it. A parent
 * already recorded stays, so the lead it names survives a later rehost; an
 * Agent parent is recorded as it is; a requested Session is recorded with the
 * Agent that owns it in this client now. */
export function presentedAgentRunParent(
	agent: Pick<RunParentedAgent, "id" | "runParent">,
	parent: AgentRunParentRefV1 | undefined,
	agents: readonly RunParentedAgent[],
): { runParent?: AgentRunParentV1 } {
	if (agent.runParent) return { runParent: agent.runParent };
	if (!parent) return {};
	if (isAgentRunParentAgent(parent)) return { runParent: { agentId: parent.agentId } };
	const lead = createAgentRunLeadResolver(agents)({
		id: agent.id,
		runParent: parent,
	});
	return {
		runParent: lead ? { ...parent, leadAgentId: lead.id } : { ...parent },
	};
}
