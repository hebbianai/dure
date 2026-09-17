import { trimTrailingSlash } from "@/lib/files/paths";
import { isHmuxProviderSessionSourceIdentity } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { t } from "@/lib/i18n";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { supportsStandaloneManagedPromotion } from "@/lib/sessions/managed/managedProviderCapabilities";
import { PROVIDERS, type Project, type Provider } from "@/types";

export type HmuxManagedPromotionAvailability =
  | "hidden"
  | "eligible"
  | "provider_unsupported"
  | "working"
  | "attention_required"
  | "not_ready"
  | "project_not_found"
  | "project_ambiguous";

export interface HmuxManagedPromotionCandidate {
  readonly kind: string;
  readonly hostId?: string;
  readonly runtime?: string;
  readonly workspaceId?: string;
  readonly provider?: Provider | null;
  readonly displayState?: AgentDisplayState;
  readonly cwd?: string;
  readonly executionLocationKnown?: boolean;
}

function ownsCwd(projectPath: string, cwd: string): boolean {
  const root = trimTrailingSlash(projectPath);
  const target = trimTrailingSlash(cwd);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Cheap, read-only Spaces/PaneChrome hint. The conversion inspection remains
 * authoritative and repeats every identity/cwd/process fence before mutation.
 */
export function hmuxManagedPromotionAvailability(
  candidate: HmuxManagedPromotionCandidate,
  projects: readonly Project[],
): HmuxManagedPromotionAvailability {
  if (
    candidate.kind !== "term" ||
    candidate.executionLocationKnown === false ||
    candidate.hostId ||
    !isHmuxProviderSessionSourceIdentity({
      kind: candidate.kind,
      runtime: candidate.runtime,
      source: "local",
      workspaceId: candidate.workspaceId,
    }) ||
    !candidate.provider
  ) {
    return "hidden";
  }
  if (!supportsStandaloneManagedPromotion(candidate.provider)) {
    return "provider_unsupported";
  }
  if (candidate.displayState === "working") return "working";
  if (
    candidate.displayState === "blocked" ||
    candidate.displayState === "error"
  ) {
    return "attention_required";
  }
  if (
    candidate.displayState === undefined ||
    candidate.displayState === "connecting" ||
    candidate.displayState === "exited"
  ) {
    return "not_ready";
  }

  const cwd = candidate.cwd?.trim();
  if (!cwd) return "project_not_found";
  const matches = projects
    .filter(
      (project) =>
        project.kind === "local" && ownsCwd(project.path, cwd),
    )
    .sort(
      (left, right) =>
        trimTrailingSlash(right.path).length - trimTrailingSlash(left.path).length,
    );
  const mostSpecific = matches[0];
  if (!mostSpecific) return "project_not_found";
  const specificity = trimTrailingSlash(mostSpecific.path).length;
  return matches.filter(
    (project) => trimTrailingSlash(project.path).length === specificity,
  ).length === 1
    ? "eligible"
    : "project_ambiguous";
}

export function hmuxManagedPromotionLabel(
  availability: HmuxManagedPromotionAvailability,
  provider?: Provider | null,
): string {
  switch (availability) {
    case "eligible":
      return t("common.switchToManagedSession");
    case "provider_unsupported":
      return t("hmux.conversion.eligibility.providerUnsupported", {
        provider: provider ? PROVIDERS[provider].label : t("hmux.conversion.eligibility.thisProvider"),
      });
    case "working":
      return t("hmux.conversion.eligibility.agentWorking");
    case "attention_required":
      return t("hmux.conversion.eligibility.attentionRequired");
    case "not_ready":
      return t("hmux.conversion.eligibility.notReady");
    case "project_not_found":
      return t("hmux.conversion.eligibility.projectNotFound");
    case "project_ambiguous":
      return t("hmux.conversion.eligibility.projectAmbiguous");
    case "hidden":
      return "";
  }
}
