import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { LoadingStatus } from "@/components/common/PanelStatus";
import {
  CircleAlert,
  GitCompareArrows,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  EmptyHint} from "@/components/common/StatusBlocks";
import { PluginMark } from "@/components/plugins/PluginMark";
import {
  refreshPluginViewCatalog,
  usePluginViewCatalog,
} from "@/components/plugins/usePluginViewCatalog";
import { DurePluginSettingsDialog } from "@/components/sidebar/DurePluginSettingsDialog";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { SearchField } from "@/components/ui/search-field";
import { t } from "@/lib/i18n";
import {
  agentIntegrationNames,
  type DurePluginCatalogEntry,
  type DurePluginCatalogOutcomeV2,
  isDurePluginSupported,
  pluginCatalogOutcomeKey,
  pluginDescription,
} from "@/lib/plugins/durePlugins";
import { pluginMarkIcon } from "@/lib/plugins/pluginMark";
import { pluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

function integrationLabel(adapter: string): string {
  if (adapter === "codex") return "Codex";
  if (adapter === "claude") return "Claude Code";
  return adapter;
}

function outcomeTitle(outcome: DurePluginCatalogOutcomeV2): string {
  if (outcome.status === "available") return outcome.entry.manifest.display_name;
  if (outcome.status === "conflict") return outcome.plugin_id;
  return (
    outcome.manifest?.display_name ??
    `${outcome.identity.source_id} · ${outcome.identity.candidate_id}`
  );
}

function outcomeDescription(outcome: DurePluginCatalogOutcomeV2): string {
  if (outcome.status === "available") return t(pluginDescription(outcome.entry));
  if (outcome.status === "conflict") {
    return t("sidebar.plugins.duplicateFound");
  }
  return t("sidebar.plugins.unavailable");
}

/** Pieces of the row's single mono meta line; the caller joins them with `·`.
 *  "Built in", "Conflict" and "Unavailable" used to be pills and now arrive as
 *  the last piece (Glass v2 §1 column D: badges on glass lose their fill and
 *  merge into text). */
function outcomeMeta(outcome: DurePluginCatalogOutcomeV2): string[] {
  if (outcome.status === "available") {
    return [
      outcome.entry.installed ? t("common.installed") : t("sidebar.plugins.available"),
      `v${outcome.entry.manifest.version}`,
      t("sidebar.plugins.builtIn"),
    ];
  }
  if (outcome.status === "conflict") {
    return [
      t("sidebar.plugins.packageCandidates", { n: outcome.candidates.length }),
      t("common.conflict"),
    ];
  }
  return [
    outcome.manifest ? `v${outcome.manifest.version}` : outcome.identity.candidate_id,
    t("common.unavailable"),
  ];
}

function rejectedReason(
  outcome: Extract<DurePluginCatalogOutcomeV2, { status: "rejected" }>,
) {
  if (outcome.reason.kind === "incompatible") {
    return t("sidebar.plugins.incompatible");
  }
  if (outcome.reason.kind === "catalog_policy_unavailable") {
    return t("sidebar.plugins.sourcePolicyUnavailable");
  }
  if (outcome.reason.kind === "invalid_contribution") {
    return t("sidebar.plugins.contributionLoadFailed");
  }
  return t("sidebar.plugins.packageReadFailed");
}

function availableEntry(
  outcome: DurePluginCatalogOutcomeV2 | undefined,
): DurePluginCatalogEntry | undefined {
  return outcome?.status === "available" ? outcome.entry : undefined;
}

function settingsTargetFingerprint(
  outcome: DurePluginCatalogOutcomeV2 | undefined,
): string | null {
  if (outcome?.status !== "available") return null;
  return JSON.stringify([
    outcome.identity.source_id,
    outcome.identity.candidate_id,
    outcome.entry.manifest.id,
    outcome.entry.manifest.version,
    outcome.entry.settings_contribution,
  ]);
}

interface PluginSettingsTarget {
  outcomeKey: string;
  fingerprint: string;
}

/** Dure 자체 plugin catalog. Agent별 native marketplace와 수명주기를 섞지 않는다. */
export function DurePluginsPane() {
  const focus = useStore((state) => state.focusCtx);
  const projects = useStore((state) => state.projects);
  const { snapshot: fullCatalog, loadState, error } = usePluginViewCatalog();
  const interfaceMode = useInterfaceMode();
  const catalog = useMemo(() => {
    if (!fullCatalog || interfaceMode === "pro") return fullCatalog;
    return {
      ...fullCatalog,
      outcomes: fullCatalog.outcomes.filter((outcome) => {
        const pluginId = outcome.status === "available"
          ? outcome.entry.manifest.id
          : outcome.status === "conflict" ? outcome.plugin_id : outcome.manifest?.id;
        return pluginId !== "dure.slack";
      }),
    };
  }, [fullCatalog, interfaceMode]);
  const loading = loadState === "loading";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [settingsTarget, setSettingsTarget] =
    useState<PluginSettingsTarget | null>(null);
  const [query, setQuery] = useState("");

  const workspace = useMemo(
    () => pluginWorkspaceContext(focus, projects),
    [focus, projects],
  );
  const workspaceScopeKey = workspace?.scopeKey ?? null;
  const workspaceRoot = workspace?.source === "local" ? workspace.root : null;

  const selectedOutcome = useMemo(() => {
    const outcomes = catalog?.outcomes ?? [];
    return (
      outcomes.find((outcome) => pluginCatalogOutcomeKey(outcome) === selectedKey) ??
      outcomes[0]
    );
  }, [catalog, selectedKey]);
  const effectiveSelectedKey = selectedOutcome
    ? pluginCatalogOutcomeKey(selectedOutcome)
    : null;
  const settingsTargetOutcome = catalog?.outcomes.find(
    (outcome) => pluginCatalogOutcomeKey(outcome) === settingsTarget?.outcomeKey,
  );
  const settingsDialogEntry =
    settingsTarget &&
    settingsTargetFingerprint(settingsTargetOutcome) === settingsTarget.fingerprint
      ? availableEntry(settingsTargetOutcome)
      : undefined;

  useEffect(() => {
    if (!catalog) return;
    setSelectedKey((current) => {
      const keys = new Set(catalog.outcomes.map(pluginCatalogOutcomeKey));
      const next =
        current && keys.has(current)
          ? current
          : (catalog.outcomes[0]
              ? pluginCatalogOutcomeKey(catalog.outcomes[0])
              : null);
      return next === current ? current : next;
    });
  }, [catalog]);

  useEffect(() => {
    if (settingsTarget && catalog && !settingsDialogEntry) {
      setSettingsTarget(null);
    }
  }, [catalog, settingsDialogEntry, settingsTarget]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return catalog?.outcomes ?? [];
    return (catalog?.outcomes ?? []).filter((outcome) => {
      const searchable = [
        outcomeTitle(outcome),
        outcomeDescription(outcome),
        outcome.status === "available" ? outcome.entry.manifest.id : null,
        outcome.status === "conflict" ? outcome.plugin_id : null,
        outcome.status === "rejected" ? outcome.identity.source_id : null,
        outcome.status === "rejected" ? outcome.identity.candidate_id : null,
      ];
      return searchable.some((value) => value?.toLowerCase().includes(normalized));
    });
  }, [catalog, query]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      <SectionHeaderRow
        as="h2"
        label={t("common.plugin")}
        actions={
          <RefreshButton
            busy={loading}
            onClick={() => void refreshPluginViewCatalog()}
          />
        }
      />
      <div className="shrink-0 px-3 pt-3.5 pb-2">
        <SearchField
          inputClassName="h-8"
          placeholder={t("sidebar.plugins.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {catalog === null && (loadState === "idle" || loading) ? (
        <LoadingStatus className="min-h-0 flex-1" />
      ) : (
      <SidebarScrollArea edgeFade className="min-h-0 flex-1" viewportClassName="pb-3">
        {error && (
          <Alert surface="outline" icon={false} className="mx-3 mt-2">
            {error}
          </Alert>
        )}
        <div className="flex flex-col gap-1 px-2 pt-3">
          {visible.map((outcome) => {
            const key = pluginCatalogOutcomeKey(outcome);
            const selectedEntry = key === effectiveSelectedKey;
            const detailEntry = availableEntry(outcome);
            return (
              <Fragment key={key}>
                <button
                  type="button"
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left",
                  selectedEntry
                    ? "bg-glass-tint-hover"
                    : "hover:bg-glass-tint",
                )}
                onClick={() => {
                  setSettingsTarget(null);
                  setSelectedKey(key);
                }}
              >
                <div
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl",
                    outcome.status === "available"
                      ? "bg-primary/12 text-primary"
                      : "bg-destructive/10 text-destructive",
                  )}
                >
                  {outcome.status === "conflict" ? (
                    <GitCompareArrows className="size-5" />
                  ) : outcome.status === "rejected" ? (
                    <CircleAlert className="size-5" />
                  ) : (
                    <PluginMark
                      icon={pluginMarkIcon(outcome.entry)}
                      className="size-5"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <OverflowRevealText className="block text-xs font-semibold" text={outcomeTitle(outcome)} />
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {outcomeDescription(outcome)}
                  </p>
                  {/* Badges on glass shed their fill and merge into one mono
                      line (Glass v2 §1 column D). The "Built in" pill that sat
                      beside the title joins it here, giving
                      `Installed · v0.2.1 · Built in` and leaving the title line
                      to hold nothing but the title.
                      The BadgeCheck icon that reported installation is now
                      column D's 6px dot. Every added icon adds vocabulary; a
                      dot says one thing only — there is state here. */}
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {outcome.status === "available" && outcome.entry.installed && (
                      <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
                    )}
                    <OverflowRevealText text={outcomeMeta(outcome).join(" · ")}
                      className="on-glass min-w-0 font-mono text-2xs font-normal text-muted-foreground" />
                  </div>
                </div>
                </button>
                {selectedEntry && outcome.status === "available" && detailEntry && (
                  <GlassPanel className="mt-1 overflow-hidden">
                    <div className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <PluginMark
                          icon={pluginMarkIcon(detailEntry)}
                          className="size-4 text-muted-foreground"
                        />
                        <span className="text-xs font-semibold">
                          {detailEntry.manifest.display_name}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                        {t(pluginDescription(detailEntry))}
                      </p>
                      {/* Chips lose their fill and merge into one mono line (Glass v2
                          §1 column D). With only two adapters it never needs to wrap. */}
                      <p className="on-glass mt-2 font-mono text-2xs font-normal text-muted-foreground">
                        {agentIntegrationNames(detailEntry).map(integrationLabel).join(" · ")}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <ShieldCheck className="size-3.5 text-status-ok" />
                        {isDurePluginSupported(detailEntry)
                          ? t("sidebar.plugins.compatible")
                          : t("sidebar.plugins.incompatible")}
                      </div>
                      {detailEntry.distribution === "bundled" && (
                        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                          {t("sidebar.plugins.builtInDescription")}
                        </p>
                      )}
                    </div>

                    {detailEntry && (
                      <div className="border-t border-glass-hairline p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                          aria-label={`${detailEntry.manifest.display_name} · ${t("sidebar.plugins.settingsTitle")}`}
                          onClick={() => {
                            const fingerprint = settingsTargetFingerprint(outcome);
                            if (key && fingerprint) {
                              setSettingsTarget({
                                outcomeKey: key,
                                fingerprint,
                              });
                            }
                          }}
                        >
                          <Settings2 className="size-3.5" />
                          {t("sidebar.plugins.settingsTitle")}
                        </Button>
                      </div>
                    )}
                  </GlassPanel>
                )}

                {selectedEntry && outcome.status === "rejected" && (
                  <Alert surface="outline" icon={false}
                    tone="destructive"
                    className="mt-1"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
                      <CircleAlert className="size-4" />
                      {outcomeTitle(outcome)}
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      {rejectedReason(outcome)}
                    </p>
                    <p className="mt-2 break-all text-[10px] leading-4 text-muted-foreground">
                      {outcome.manifest
                        ? `${outcome.manifest.id} · `
                        : null}
                      {outcome.identity.source_id} ·{" "}
                      {outcome.identity.candidate_id}
                    </p>
                  </Alert>
                )}

                {selectedEntry && outcome.status === "conflict" && (
                  <Alert surface="outline" icon={false}
                    tone="destructive"
                    className="mt-1"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
                      <GitCompareArrows className="size-4" />
                      {t("sidebar.plugins.duplicateTitle")}
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      {t("sidebar.plugins.noPackageAutoSelected")}
                    </p>
                    {/* Candidates can run to several lines, so they stay one per line
                        rather than merging — only the fill goes. The `·` inside each
                        line is the original field separator. */}
                    <div className="mt-2 flex flex-col gap-0.5">
                      {outcome.candidates.map((candidate) => (
                        <OverflowRevealText
                          key={`${candidate.source_id}:${candidate.candidate_id}`}
                          className="on-glass font-mono text-2xs font-normal text-muted-foreground"
                          text={`${candidate.source_id} · ${candidate.candidate_id} · v${candidate.version}`}
                        />
                      ))}
                    </div>
                  </Alert>
                )}
              </Fragment>
            );
          })}
        </div>

        {catalog && visible.length === 0 && (
          <EmptyHint className="px-4 py-6">{t("common.noResults")}</EmptyHint>
        )}

      </SidebarScrollArea>
      )}
      <DurePluginSettingsDialog
        key={`${settingsTarget?.fingerprint ?? "closed"}:${workspaceScopeKey ?? "no-workspace"}`}
        entry={settingsDialogEntry}
        open={settingsDialogEntry !== undefined}
        onOpenChange={(open) => {
          if (!open) setSettingsTarget(null);
        }}
        workspaceScopeKey={workspaceScopeKey}
        workspaceRoot={workspaceRoot}
      />
    </div>
  );
}
