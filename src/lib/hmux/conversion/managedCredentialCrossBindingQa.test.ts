import { beforeEach, expect, it, vi } from "vitest";
import { ManagedAgentInputError } from "@/lib/sessions/managed/managedAgentInputError";
import type { AccountProfile } from "@/types";
import { runManagedCredentialCrossBindingQa } from "./managedCredentialCrossBindingQa";

const mocks = vi.hoisted(() => ({
	agent: { id: "qa-agent", name: "QA target", provider: "codex" },
	add: vi.fn(),
	ensure: vi.fn(),
	identity: vi.fn(),
	managedIdentity: vi.fn(),
	inspect: vi.fn(),
	state: vi.fn(),
	switchCredential: vi.fn(),
	submit: vi.fn(),
	listSessions: vi.fn(),
	pane: vi.fn(),
	send: vi.fn(),
	open: vi.fn(),
	remove: vi.fn(),
	surface: vi.fn(),
	dispose: vi.fn(),
}));

vi.mock("@/lib/agents/agentCredentialTransition", () => ({
	requestAgentCredentialTransition: mocks.switchCredential,
}));
vi.mock("@/lib/agents/resourceLifecycle", () => ({
	removeAgentWithResources: mocks.remove,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionsExact: mocks.inspect,
}));
vi.mock("@/lib/ipc", () => ({
	hmux: { listSessions: mocks.listSessions },
	homeDir: async () => "/isolated-qa/home",
	listDir: async () => [{ name: ".qa-managed-launch-ready" }],
}));
vi.mock("@/lib/sessions/managed/managedAgentInput", () => ({
	sendHmuxInitialAgentPrompt: mocks.send,
	sendHmuxAgentCommandInput: mocks.submit,
}));
vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensure,
	ensureManagedConversationIdentity: mocks.identity,
	MANAGED_BOOTSTRAP_GEOMETRY: { columns: 120, rows: 30 },
}));
vi.mock("@/lib/sessions/managed/managedConversationIdentity", () => ({
	managedConversationId: mocks.managedIdentity,
}));
vi.mock("@/lib/workspace/dock", () => ({ openAgentPanel: mocks.open }));
vi.mock("@/lib/workspace/dock/dockPanelParameters", () => ({
	findAgentPanel: mocks.pane,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: () => ({}),
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: mocks.state,
	},
}));
vi.mock("@/lib/agents/agentRegistration", () => ({ addAgent: mocks.add }));
vi.mock("@/lib/hmux/conversion/managedCredentialQaSurface", () => ({
	ManagedCredentialQaSurface: class {
		constructor(...args: unknown[]) {
			mocks.surface(...args);
		}
		waitForRetirement() {
			return undefined;
		}
		async waitUntilReady() {}
		async focus() {}
		async observeMarker() {
			return { markerCounts: { painted: 1, projection: 1 } };
		}
		snapshot() {
			return {
				disconnections: 0,
				errors: [],
				synchronizations: 1,
				gridTransitions: [{ columns: 120, rows: 30 }],
			};
		}
		dispose() {
			mocks.dispose();
		}
	},
	managedCredentialTargetSurfaceStayedContinuous: vi.fn(),
	sameTerminalGrid: () => true,
	structuredTerminalGrid: () => ({ columns: 120, rows: 30 }),
}));

const prompt =
	"Reply exactly HMUX_CROSSBIND_TARGET_READY and do not run tools.";
const afterAdmission = new Error(
	"Identity observation reached after prompt admission",
);
const log = vi.fn();
const run = () =>
	runManagedCredentialCrossBindingQa(
		"qa-project",
		{ id: "qa-selected" } as AccountProfile,
		log,
	);

beforeEach(() => {
	vi.resetAllMocks();
	mocks.state.mockReturnValue({
		agents: [mocks.agent],
		activeSpaceId: "qa-space",
	});
	mocks.add.mockResolvedValue(mocks.agent);
	mocks.ensure.mockResolvedValue({
		agent: mocks.agent,
		initialPromptAccepted: true,
	});
	mocks.open.mockReturnValue("pane-opaque-qa");
	mocks.send.mockResolvedValue(undefined);
	mocks.remove.mockResolvedValue(undefined);
	// Stop this launch-boundary fixture before provider observation or rehost.
	mocks.identity.mockRejectedValue(afterAdmission);
});

const beforeSwitch = new Error("Reached credential switch after the QA turn");

function crossBindingPhase(completedCount = "1") {
	const agents = ["target", "sibling"].map((id) => ({
		id,
		name: id,
		provider: "codex",
		conversationId: `conversation-${id}`,
		runtimeBinding: {
			runtime: "hmux_managed_v1",
			source: "local",
			sessionId: `session-${id}`,
			workspaceId: "qa-project",
		},
	}));
	let submitted = false;
	let acknowledged = false;
	let afterSubmitObservations = 0;
	mocks.state.mockReturnValue({ agents, activeSpaceId: "qa-space" });
	mocks.add.mockResolvedValueOnce(agents[0]).mockResolvedValueOnce(agents[1]);
	mocks.ensure.mockImplementation(async (agent) => ({
		initialPromptAccepted: true,
		credentialId: agent.id === "sibling" ? "qa-selected" : null,
		session: { sessionClass: "managed", lifecycle: "ready" },
	}));
	mocks.identity.mockImplementation(async (agent) => agent.conversationId);
	mocks.managedIdentity.mockImplementation((agent) => agent.conversationId);
	mocks.open.mockImplementation((_space, agent) => `pane-${agent.id}`);
	mocks.pane.mockImplementation((_api, agentId) => ({ id: `pane-${agentId}` }));
	mocks.listSessions.mockResolvedValue([
		{ sessionId: "session-sibling", workspaceId: "qa-project" },
	]);
	mocks.submit.mockImplementation(async () => {
		submitted = true;
		return { state: "applied" };
	});
	mocks.inspect.mockImplementation(async ([target]) => {
		if (target.sessionId === "session-target" && submitted) {
			afterSubmitObservations += 1;
			acknowledged = afterSubmitObservations > 1;
		}
		return [
			{
				outcome: "found",
				agentRuntimeState: {
					lifecycle: "running",
					activity: "waiting",
					source: "provider_event",
					attention: "none",
					attentionId: null,
					turnCompletedCount: acknowledged
						? String(BigInt(completedCount) + 1n)
						: completedCount,
				},
			},
		];
	});
	mocks.switchCredential.mockImplementation(async () => {
		if (!submitted || !acknowledged) {
			throw new Error("The QA marker is still an uncompleted draft");
		}
		throw beforeSwitch;
	});
	return { target: agents[0], observations: () => afterSubmitObservations };
}

it.each(["1", "9007199254740993"])(
	"submits its own marker and waits past the old completed turn (%s)",
	async (completedCount) => {
		const fixture = crossBindingPhase(completedCount);
		await expect(run()).rejects.toBe(beforeSwitch);
		expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(
			fixture.target,
			"",
			true,
		);
		expect(fixture.observations()).toBe(2);
		expect(mocks.switchCredential).toHaveBeenCalledOnce();
	},
);

it.each(["not_written", "body_written_submit_unknown", "unknown"] as const)(
	"does not retry an uncertain marker submission or switch credentials (%s)",
	async (deliveryState) => {
		crossBindingPhase();
		const failure = new ManagedAgentInputError(
			"input_refused",
			"QA submit failed",
		);
		failure.deliveryState = deliveryState;
		mocks.submit.mockRejectedValue(failure);
		await expect(run()).rejects.toBe(failure);
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.switchCredential).not.toHaveBeenCalled();
	},
);

it("passes the exact initial prompt to the managed create owner", async () => {
	await expect(run()).rejects.toBe(afterAdmission);
	expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith(mocks.agent, {
		columns: 120,
		rows: 30,
		initialPrompt: prompt,
	});
});

it("does not send a second input after the create receipt accepted the prompt", async () => {
	await expect(run()).rejects.toBe(afterAdmission);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.open).toHaveBeenCalledExactlyOnceWith("qa-space", mocks.agent);
	expect(mocks.surface).toHaveBeenCalledExactlyOnceWith(
		"qa-space",
		"pane-opaque-qa",
	);
	expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("qa-agent");
	expect(mocks.dispose).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
	"sends once when create did not report prompt acceptance (%s)",
	async (initialPromptAccepted) => {
		mocks.ensure.mockResolvedValue({
			agent: mocks.agent,
			initialPromptAccepted,
		});
		await expect(run()).rejects.toBe(afterAdmission);
		expect(mocks.send).toHaveBeenCalledExactlyOnceWith(mocks.agent, prompt);
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("qa-agent");
	},
);

it("preserves a refused create without mounting a pane or sending input", async () => {
	const refusal = new Error("Managed create was refused");
	mocks.ensure.mockRejectedValue(refusal);
	await expect(run()).rejects.toBe(refusal);
	expect(mocks.ensure).toHaveBeenCalledOnce();
	expect(mocks.open).not.toHaveBeenCalled();
	expect(mocks.surface).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("qa-agent");
});

it.each(["not_written", "body_written_submit_unknown", "unknown"] as const)(
	"does not retry failed initial input (%s)",
	async (deliveryState) => {
		const failure = new ManagedAgentInputError(
			"input_refused",
			"Initial input failed",
		);
		failure.deliveryState = deliveryState;
		mocks.ensure.mockResolvedValue({ agent: mocks.agent });
		mocks.send.mockRejectedValue(failure);
		await expect(run()).rejects.toBe(failure);
		expect(mocks.ensure).toHaveBeenCalledOnce();
		expect(mocks.send).toHaveBeenCalledExactlyOnceWith(mocks.agent, prompt);
		expect(mocks.identity).not.toHaveBeenCalled();
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("qa-agent");
		expect(mocks.dispose).toHaveBeenCalledOnce();
	},
);
