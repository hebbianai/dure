import { pathBasename, trimTrailingSlash } from "@/lib/files/paths";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import type {
  HmuxManagedPaneBindingV1,
  HmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
  isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { sameTerminalEnvironment } from "@/lib/terminal/terminalEnvironmentEquality";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";
import {
  cloneJson,
  recordOf,
  replacePanelReferences,
} from "@/lib/workspace/layout/serializedLayoutJson";
import type {
  Agent,
  DetectedWorktree,
  Project,
  Provider,
  TerminalEnvironment,
} from "@/types";

type ConvertibleBinding =
  | HmuxManagedPaneBindingV1
  | HmuxStandalonePaneBindingV1;

type PromotionSourceBinding = HmuxProviderSessionSourceBinding;

type UnknownRecord = Record<string, unknown>;

export class HmuxAgentPanePromotionError extends Error {
  constructor(
    readonly code:
      | "agent_identity_conflict"
      | "agent_name_conflict"
      | "invalid_agent_name"
      | "project_ambiguous"
      | "project_not_found",
    message: string,
  ) {
    super(message);
    this.name = "HmuxAgentPanePromotionError";
  }
}

export interface HmuxManagedAgentPromotion {
  agentId: string;
  agentName: string;
  projectId: string;
  branch: string;
  sourcePanelId: string;
  targetPanelId: string;
  conversionId: string;
  terminalEnvironment: TerminalEnvironment;
}

export interface ResolveHmuxManagedAgentPromotionInput {
  sourcePanelId: string;
  conversionId: string;
  providerId: Provider;
  cwd: string;
  sourceBinding: PromotionSourceBinding;
  currentBinding: ConvertibleBinding;
  preferredName?: string;
  terminalEnvironment: TerminalEnvironment;
  projects: readonly Project[];
  detected: Readonly<Record<string, readonly DetectedWorktree[] | undefined>>;
  agents: readonly Agent[];
}

export type HmuxAgentPanePromotionLayoutState =
  | "source"
  | "target"
  | "missing"
  | "conflict";

function pathOwnsCwd(projectPath: string, cwd: string): boolean {
  const root = trimTrailingSlash(projectPath);
  const target = trimTrailingSlash(cwd);
  return target === root || target.startsWith(`${root}/`);
}

export function hmuxManagedPromotionAgentId(conversionId: string): string {
  const digest = conversionId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(-16);
  if (!digest) {
    throw new HmuxAgentPanePromotionError(
      "agent_identity_conflict",
      "Hmux conversion has no stable Agent identity",
    );
  }
  return `agent-hmux-${digest}`;
}

function sameBinding(
  left: Agent["runtimeBinding"],
  right: ConvertibleBinding,
): boolean {
  if (
    left?.runtime !== right.runtime ||
    left.source !== right.source ||
    left.hostId !== right.hostId ||
    left.sessionId !== right.sessionId
  ) {
    return false;
  }
  if ("workspaceId" in right) {
    if (!("workspaceId" in left) || left.workspaceId !== right.workspaceId) {
      return false;
    }
  } else if ("workspaceId" in left) {
    return false;
  }
  if (
    left.runtime === "hmux_managed_v1" &&
    right.runtime === "hmux_managed_v1"
  ) {
    return (
      left.createIdempotencyKey === right.createIdempotencyKey &&
      left.credentialId === right.credentialId &&
      left.credentialGeneration === right.credentialGeneration &&
      sameHmuxManagedGeneration(left.stopFence, right.stopFence)
    );
  }
  return true;
}

function exactPromotionAgent(
  agent: Agent,
  input: ResolveHmuxManagedAgentPromotionInput,
  projectId: string,
): boolean {
  const bindingMatches =
    sameBinding(agent.runtimeBinding, input.sourceBinding) ||
    sameBinding(agent.runtimeBinding, input.currentBinding);
  const credentialId =
    input.currentBinding.runtime === "hmux_managed_v1"
      ? input.currentBinding.credentialId
      : undefined;
  return (
    agent.projectId === projectId &&
    agent.provider === input.providerId &&
    trimTrailingSlash(agent.worktreePath) === trimTrailingSlash(input.cwd) &&
    bindingMatches &&
    agent.sessionId === agent.runtimeBinding?.sessionId &&
    agent.credentialId === credentialId &&
    sameTerminalEnvironment(agent.terminalEnv, input.terminalEnvironment)
  );
}

export function resolveHmuxManagedAgentPromotion(
  input: ResolveHmuxManagedAgentPromotionInput,
): HmuxManagedAgentPromotion {
  const projectMatches = input.projects
    .filter(
      (project) =>
        project.kind === "local" && pathOwnsCwd(project.path, input.cwd),
    )
    .sort(
      (left, right) =>
        trimTrailingSlash(right.path).length - trimTrailingSlash(left.path).length,
    );
  const project = projectMatches[0];
  if (!project) {
    throw new HmuxAgentPanePromotionError(
      "project_not_found",
      `no local project owns Hmux cwd ${input.cwd}`,
    );
  }
  const equallySpecific = projectMatches.filter(
    (candidate) =>
      trimTrailingSlash(candidate.path).length ===
      trimTrailingSlash(project.path).length,
  );
  if (equallySpecific.length !== 1) {
    throw new HmuxAgentPanePromotionError(
      "project_ambiguous",
      `multiple local projects own Hmux cwd ${input.cwd}`,
    );
  }

  const agentName = (input.preferredName?.trim() || pathBasename(trimTrailingSlash(input.cwd), "")).trim();
  if (!agentName || agentName.includes("/")) {
    throw new HmuxAgentPanePromotionError(
      "invalid_agent_name",
      "managed Agent name must be non-empty and cannot contain '/'",
    );
  }

  const plannedAgentId = hmuxManagedPromotionAgentId(input.conversionId);
  const idOwner = input.agents.find((agent) => agent.id === plannedAgentId);
  if (idOwner && !exactPromotionAgent(idOwner, input, project.id)) {
    throw new HmuxAgentPanePromotionError(
      "agent_identity_conflict",
      `Agent identity ${plannedAgentId} is already owned by another runtime`,
    );
  }
  const nameOwners = input.agents.filter(
    (agent) => agent.projectId === project.id && agent.name === agentName,
  );
  if (
    nameOwners.length > 1 ||
    nameOwners.some((agent) => !exactPromotionAgent(agent, input, project.id))
  ) {
    throw new HmuxAgentPanePromotionError(
      "agent_name_conflict",
      `Agent name conflict for ${project.name}/${agentName}; choose a distinct --agent-name`,
    );
  }

  const reusable = idOwner ?? nameOwners[0];
  if (reusable && reusable.name !== agentName) {
    throw new HmuxAgentPanePromotionError(
      "agent_identity_conflict",
      `Agent identity ${reusable.id} is already named ${reusable.name}`,
    );
  }
  const detectedBranch =
    input.detected[project.id]?.find(
      (worktree) => trimTrailingSlash(worktree.path) === trimTrailingSlash(input.cwd),
    )?.branch ?? "";
  const agentId = reusable?.id ?? plannedAgentId;
  return {
    agentId,
    agentName: reusable?.name ?? agentName,
    projectId: project.id,
    branch: reusable?.branch ?? detectedBranch,
    sourcePanelId: input.sourcePanelId,
    targetPanelId: input.sourcePanelId,
    conversionId: input.conversionId,
    terminalEnvironment: { ...input.terminalEnvironment },
  };
}

function bindingFromPanelDefinition(
  definition: UnknownRecord,
): ConvertibleBinding | undefined {
  const params = recordOf(definition.params);
  const binding = params?.binding;
  if (
    !isTerminalPaneBindingV1(binding) ||
    binding.source !== "local" ||
    (binding.runtime !== "hmux_standalone_v1" &&
      binding.runtime !== "hmux_managed_v1")
  ) {
    return undefined;
  }
  return binding;
}

function exactTargetPanel(
  definition: UnknownRecord,
  promotion: HmuxManagedAgentPromotion,
): boolean {
  return (
    definition.id === promotion.targetPanelId &&
    paneContentComponent(definition) === "agent" &&
    agentIdFromPaneParameters(recordOf(definition.params)) === promotion.agentId
  );
}

export function projectHmuxManagedAgentPaneLayout(
  layout: unknown,
  promotion: HmuxManagedAgentPromotion,
  source: HmuxProviderSessionSourceBinding,
  target: HmuxManagedPaneBindingV1,
): { state: HmuxAgentPanePromotionLayoutState; layout: unknown } {
  const next = cloneJson(layout);
  const panels = recordOf(recordOf(next)?.panels);
  if (!panels) return { state: "conflict", layout };

  const sourceDefinition = recordOf(panels[promotion.sourcePanelId]);
  const targetDefinition = recordOf(panels[promotion.targetPanelId]);
  if (sourceDefinition && targetDefinition && promotion.sourcePanelId !== promotion.targetPanelId) {
    return { state: "conflict", layout: next };
  }
  if (targetDefinition && paneContentComponent(targetDefinition) === "agent") {
    return {
      state: exactTargetPanel(targetDefinition, promotion)
        ? "target"
        : "conflict",
      layout: next,
    };
  }
  if (!sourceDefinition) return { state: targetDefinition ? "conflict" : "missing", layout: next };
  if (paneContentComponent(sourceDefinition) !== "terminal") return { state: "conflict", layout: next };

  const currentBinding = bindingFromPanelDefinition(sourceDefinition);
  if (
    !currentBinding ||
    (!sameBinding(currentBinding, source) &&
      !sameBinding(currentBinding, target))
  ) {
    return { state: "conflict", layout: next };
  }
  delete panels[promotion.sourcePanelId];
  sourceDefinition.id = promotion.targetPanelId;
  sourceDefinition.contentComponent = "agent";
  sourceDefinition.title = promotion.agentName;
  sourceDefinition.params = { agentRef: { agentId: promotion.agentId } };
  panels[promotion.targetPanelId] = sourceDefinition;
  // Already accepted legacy promotions retain their recorded target ID.
  if (promotion.sourcePanelId !== promotion.targetPanelId) {
    replacePanelReferences(next, promotion.sourcePanelId, promotion.targetPanelId);
  }
  return { state: "source", layout: next };
}
