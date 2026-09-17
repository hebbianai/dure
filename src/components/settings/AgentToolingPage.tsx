// Agent tooling derives one next-action summary from the same lifecycle records
// shown below it. Safe integration lifecycle actions use the doctor-owned bulk
// command; destructive provider removal retains an explicit confirmation.
import { Download, RefreshCw } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { useCallback, useEffect, useState } from "react";
import { PageTitle } from "@/components/settings/PageTitle";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { InsetPanel } from "@/components/ui/inset-panel";
import { Separator } from "@/components/ui/separator";
import {
  type AgentEnvironmentIntegrationDetail,
  type AgentEnvironmentReport,
  type AgentEnvironmentSkillDetail,
  integrationDetailsOf,
  skillDetailsOf,
} from "@/lib/agents/agentEnvironment";
import {
  probeAgentToolingEnvironment,
  resolveAgentToolingCommand,
} from "@/lib/agents/agentToolingEnvironment";
import {
  type AgentToolingGuidance,
  type AgentToolingGuidanceAction,
  deriveAgentToolingGuidance,
} from "@/lib/agents/agentToolingGuidance";
import { runShell } from "@/lib/ipc/process";
import { t } from "@/lib/i18n";
import {
  type DureCliInstallStatus,
  installDureCli,
} from "@/lib/ipc/system";
import { projectAgentToolingUpdateNotice } from "@/lib/updates/agentToolingUpdateSource";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PendingIntegrationRemoval {
  key: string;
  title: string;
  command: string;
  description: string;
}

/** Known dependency IDs use UI-owned translations instead of CLI labels. */
function dependencyLabel(id: string, cliLabel: string): string {
  switch (id) {
    case "session-hook":
      return t("settings.agentTooling.hook.claudeSessionStart");
    case "codex-session-hook":
      return t("settings.agentTooling.hook.codexSessionStart");
    case "gemini-session-hook":
      return t("settings.agentTooling.hook.geminiSessionStart");
    default:
      return cliLabel;
  }
}

const INTEGRATION_PROVIDER_TITLES: Record<
  AgentEnvironmentIntegrationDetail["provider"],
  string
> = {
  claude: "Claude",
  codex: "Codex",
};

function integrationTitle(
  provider: AgentEnvironmentIntegrationDetail["provider"],
): string {
  return `${t("settings.agentTooling.orchestrationIntegration")} · ${INTEGRATION_PROVIDER_TITLES[provider]}`;
}

function integrationDescription(
  detail: AgentEnvironmentIntegrationDetail,
  fullDigest = false,
): string {
  const digest = fullDigest ? detail.digest : detail.digest?.slice(0, 12);
  return `${detail.installRoot} · ${detail.version ?? "-"} · ${digest ?? "-"} · ${detail.channel ?? "-"} · ${detail.transportRef ?? "-"} · ${detail.capabilities.join(", ") || "-"}`;
}

function integrationStatus(detail: AgentEnvironmentIntegrationDetail): string {
  if (detail.status === "current") return t("settings.agentTooling.status.installedCurrent");
  if (detail.status === "missing") return t("common.notInstalled");
  return t("settings.agentTooling.status.updateAvailable");
}

function skillTitle(detail: AgentEnvironmentSkillDetail): string {
  return `${detail.name} · ${INTEGRATION_PROVIDER_TITLES[detail.provider]}`;
}

function skillStatus(detail: AgentEnvironmentSkillDetail): string {
  switch (detail.state) {
    case "current":
      return t("settings.agentTooling.status.installedCurrent");
    case "missing":
      return t("common.notInstalled");
    case "outdated":
      return t("settings.agentTooling.status.updateAvailable");
    case "modified":
      return t("settings.agentTooling.skillState.modified");
    case "unmanaged":
      return t("settings.agentTooling.skillState.unmanaged");
  }
}

function cliIdentityDescription(status: DureCliInstallStatus | null): string | undefined {
  if (!status) return undefined;
  const available = `${status.available.installRoot} · ${status.available.version} · ${status.available.digest}`;
  if (status.state !== "outdated" || !status.installed) return available;
  return `${status.installed.version} · ${status.installed.digest} → ${available}`;
}

function withCliIdentity(copy: string, status: DureCliInstallStatus | null): string {
  const identity = cliIdentityDescription(status);
  return identity ? `${copy}\n${identity}` : copy;
}

function cliDescription(
  report: AgentEnvironmentReport | null,
  status: DureCliInstallStatus | null,
): string | undefined {
  if (!report) return undefined;
  if (report.cliState === "missing") {
    return t("settings.agentTooling.cli.requiredDesc");
  }
  if (report.cliState === "outdated") {
    return withCliIdentity(
      t("settings.agentTooling.cli.updateAvailableDesc"),
      status,
    );
  }
  if (status?.state === "current") {
    return withCliIdentity(
      t("settings.agentTooling.cli.availableDesc"),
      status,
    );
  }
  return `${t("settings.agentTooling.cli.availableDesc")}\n${t("settings.agentTooling.cli.updateCheckFailed")}`;
}

function cliStatusLabel(
  report: AgentEnvironmentReport | null,
  status: DureCliInstallStatus | null,
): string | undefined {
  if (!report) return t("common.checking");
  if (report.cliState === "missing") return undefined;
  if (report.cliState === "outdated") return t("settings.agentTooling.status.updateAvailable");
  return status?.state === "current"
    ? t("settings.agentTooling.status.installedCurrent")
    : t("settings.agentTooling.status.installedCompatible");
}

function guidanceActionTitle(action: AgentToolingGuidanceAction): string {
  if (action.target === "cli") return t("Dure CLI");
  if (action.target === "integration") return integrationTitle(action.detail.provider);
  if (action.target === "skills") return t("settings.agentTooling.skills");
  return dependencyLabel(action.dependency.id, action.dependency.label);
}

function guidanceCopy(guidance: AgentToolingGuidance): {
  title: string;
  description: string;
} {
  if (guidance.state === "missing") {
    return {
      title: t("common.agentToolingInstallRequired"),
      description: t("settings.agentTooling.cli.installToInspect"),
    };
  }
  if (guidance.state === "outdated") {
    return {
      title: t("common.agentToolingUpdateRequired"),
      description: t("settings.agentTooling.cli.updateToInspect"),
    };
  }
  return {
    title: t("settings.agentTooling.partialSetup"),
    description: t("common.actionItemsSummary", {
      count: guidance.actionCount,
      item: guidanceActionTitle(guidance.nextAction),
    }),
  };
}

function guidanceActionKey(action: AgentToolingGuidanceAction): string {
  if (action.target === "cli") return "cli";
  if (action.target === "integration") return "orchestration-integration";
  if (action.target === "skills") return "dure-skills";
  return action.dependency.id;
}

/** One tooling record with its status and bounded lifecycle actions. */
function ToolingRow({
  title,
  desc,
  status,
  action,
}: {
  title: string;
  desc?: string;
  status?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-start gap-3">
      <div className="flex min-h-8 min-w-px flex-1 flex-col justify-center gap-1.5">
        <div className="flex w-full items-center gap-3">
          <span className="min-w-px flex-1 text-sm font-medium text-foreground">{title}</span>
          {status && (
            <span className="shrink-0 pr-2 text-xs text-muted-foreground">{status}</span>
          )}
        </div>
        {desc && <p className="w-full whitespace-pre-line text-xs break-words text-muted-foreground">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function AgentToolingPage() {
  const [report, setReport] = useState<AgentEnvironmentReport | null>(null);
  const [cliInstallStatus, setCliInstallStatus] = useState<DureCliInstallStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingIntegrationRemoval, setPendingIntegrationRemoval] =
    useState<PendingIntegrationRemoval | null>(null);

  const probe = useCallback(async () => {
    const next = await probeAgentToolingEnvironment();
    projectAgentToolingUpdateNotice(next);
    setCliInstallStatus(next.cliInstallStatus);
    setReport(next.report);
    if (next.report.cliState === "ok") setError(null);
    return next.report;
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const fix = async (id: string, command: string): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      const result = await runShell(
        resolveAgentToolingCommand(cliInstallStatus, command),
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || String(result.code));
      }
      await probe();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const integrationDependency = report?.dependencies.find(
    (dependency) => dependency.id === "orchestration-integration",
  );

  const runIntegrationAction = (action: "install" | "update") => {
    const command =
      action === "install"
        ? integrationDependency?.fixCommand
        : integrationDependency?.updateCommand;
    if (!command) return;
    void fix("orchestration-integration", command);
  };

  const requestIntegrationRemoval = (detail: AgentEnvironmentIntegrationDetail) => {
    setError(null);
    setPendingIntegrationRemoval({
      key: `orchestration-integration:${detail.provider}`,
      title: integrationTitle(detail.provider),
      command: detail.uninstallCommand,
      description: `${integrationDescription(detail, true)}\n${detail.uninstallCommand}`,
    });
  };

  const applyPendingIntegrationRemoval = async () => {
    if (!pendingIntegrationRemoval) return;
    if (await fix(pendingIntegrationRemoval.key, pendingIntegrationRemoval.command)) {
      setPendingIntegrationRemoval(null);
    }
  };

  const installCli = async () => {
    setBusy("cli");
    setError(null);
    try {
      await installDureCli();
      const next = await probe();
      if (next.cliState !== "ok") {
        throw new Error(
          next.cliState === "outdated"
            ? t("settings.agentTooling.cli.inactiveAfterInstall")
            : t("settings.agentTooling.cli.missingAfterInstall"),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const cliOk = report?.cliState === "ok";
  const guidance = deriveAgentToolingGuidance(report);
  const guidanceContent = guidance ? guidanceCopy(guidance) : null;
  const guidanceBusy = guidance
    ? busy === guidanceActionKey(guidance.nextAction)
    : false;

  const runGuidanceAction = () => {
    const action = guidance?.nextAction;
    if (!action) return;
    if (action.target === "cli") {
      void installCli();
      return;
    }
    if (action.target === "integration") {
      runIntegrationAction(action.operation);
      return;
    }
    if (action.target === "skills") {
      void fix("dure-skills", action.command);
      return;
    }
    void fix(action.dependency.id, action.dependency.fixCommand);
  };

  return (
    <>
      <PageTitle
        title={t("settings.agentTooling.title")}
        desc={t("settings.agentTooling.description")}
      />
      <div className="flex w-full flex-col gap-6 pt-2">
        {guidance && guidanceContent ? (
          // role="region" keeps the labelled-landmark semantics of the former
          // <section aria-label=...> element.
          <InsetPanel
            role="region"
            aria-label={t("settings.agentTooling.actionRequiredAria")}
            className="rounded-lg bg-muted/30 p-4"
          >
            <ToolingRow
              title={guidanceContent.title}
              desc={guidanceContent.description}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={busy !== null}
                  onClick={runGuidanceAction}
                >
                  {guidanceBusy ? (
                    <DureLoader decorative />
                  ) : guidance.nextAction.operation === "install" ? (
                    <Download className="size-3" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {guidanceBusy
                    ? guidance.nextAction.operation === "update"
                      ? t("common.updating")
                      : t("common.installing")
                    : guidance.nextAction.operation === "update"
                      ? t("common.update")
                      : t("common.install")}
                </Button>
              }
            />
            {error && pendingIntegrationRemoval === null ? (
              <ErrorText className="mt-3">
                {t("settings.agentTooling.changeFailed", { error })}
              </ErrorText>
            ) : null}
          </InsetPanel>
        ) : null}
        <ToolingRow
          title={t("Dure CLI")}
          desc={cliDescription(report, cliInstallStatus)}
          status={cliStatusLabel(report, cliInstallStatus)}
          action={
            report === null || cliOk ? undefined : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                disabled={busy !== null}
                onClick={() => void installCli()}
              >
                {busy === "cli" ? (
                  <DureLoader decorative />
                ) : (
                  <Download className="size-3" />
                )}
                {busy === "cli"
                  ? t("common.installing")
                  : error
                    ? t("common.retry")
                    : report.cliState === "outdated"
                      ? t("common.update")
                      : t("common.install")}
              </Button>
            )
          }
        />
        {(report ? integrationDetailsOf(report) : []).map((detail) => (
          <ToolingRow
            key={`orchestration-integration:${detail.provider}`}
            title={integrationTitle(detail.provider)}
            desc={integrationDescription(detail)}
            status={integrationStatus(detail)}
            action={
              <div className="flex shrink-0 items-center gap-2">
                {detail.status === "missing" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={busy !== null}
                    onClick={() => runIntegrationAction("install")}
                  >
                    <Download className="size-3" />
                    {busy === "orchestration-integration" ? t("common.installing") : t("settings.agentTooling.installAll")}
                  </Button>
                ) : detail.status === "current" ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={busy !== null}
                    onClick={() => runIntegrationAction("update")}
                  >
                    {busy === "orchestration-integration" ? (
                      <DureLoader decorative />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {busy === "orchestration-integration" ? t("common.updating") : t("settings.agentTooling.updateAll")}
                  </Button>
                )}
                {detail.status !== "missing" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={busy !== null}
                    onClick={() => requestIntegrationRemoval(detail)}
                  >
                    {t("common.remove")}
                  </Button>
                ) : null}
              </div>
            }
          />
        ))}
        {(report ? skillDetailsOf(report) : []).map((detail) => {
          const skillKey = `dure-skills:${detail.provider}:${detail.name}`;
          const skillBusy = busy === skillKey;
          return (
            <ToolingRow
              key={skillKey}
              title={skillTitle(detail)}
              desc={detail.target}
              status={skillStatus(detail)}
              action={
                detail.state === "current" ? undefined : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={busy !== null}
                    onClick={() =>
                      void fix(
                        skillKey,
                        detail.state === "missing"
                          ? detail.fixCommand
                          : detail.updateCommand,
                      )
                    }
                  >
                    {skillBusy ? (
                      <DureLoader decorative />
                    ) : detail.state === "missing" ? (
                      <Download className="size-3" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {detail.state === "missing"
                      ? skillBusy
                        ? t("common.installing")
                        : t("common.install")
                      : skillBusy
                        ? t("common.updating")
                        : t("common.update")}
                  </Button>
                )
              }
            />
          );
        })}
        {(report?.dependencies ?? [])
          .filter(
            (dependency) =>
              dependency.id !== "orchestration-integration" &&
              dependency.id !== "dure-skills",
          )
          .map((dependency) => (
          <ToolingRow
            key={dependency.id}
            title={dependencyLabel(dependency.id, dependency.label)}
            desc={dependency.ok ? undefined : dependency.fixCommand}
            status={dependency.ok ? t("common.installed") : undefined}
            action={
              dependency.ok ? undefined : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={busy !== null}
                  onClick={() => void fix(dependency.id, dependency.fixCommand)}
                >
                  <Download className="size-3" />
                  {busy === dependency.id ? t("common.installing") : t("common.install")}
                </Button>
              )
            }
          />
        ))}
        <Separator />
        <ToolingRow
          title={t("settings.agentTooling.installStatus.title")}
          desc={t("settings.agentTooling.installStatus.desc")}
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              disabled={busy !== null}
              onClick={() => void probe()}
            >
              <RefreshCw className="size-3" />
              {t("common.recheck")}
            </Button>
          }
        />
      </div>
      <Dialog
        open={pendingIntegrationRemoval !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setPendingIntegrationRemoval(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{pendingIntegrationRemoval?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-all">
              {pendingIntegrationRemoval?.description}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <ErrorText>
              {t("settings.agentTooling.changeFailed", { error })}
            </ErrorText>
          ) : null}
          <DialogActionFooter
            cancelLabel={t("common.cancel")}
            onCancel={() => {
              setPendingIntegrationRemoval(null);
              setError(null);
            }}
            confirmLabel={t("common.remove")}
            busyLabel={t("common.removing")}
            busy={busy !== null}
            onConfirm={() => void applyPendingIntegrationRemoval()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
