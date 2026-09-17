import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { DureLoader } from "@/components/ui/dure-loader";
import { LoadingRow} from "@/components/common/StatusBlocks";
import { PluginPermissionControls } from "@/components/plugins/PluginPermissionControls";
import { SlackTeamConnections } from "@/components/plugins/SlackTeamConnections";
import {
  invalidatePluginSettingsSnapshot,
  publishPluginSettingsSnapshot,
  revalidatePluginSettingsSnapshot,
} from "@/components/plugins/usePluginIssueTrackerWorkspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type {
  PluginSettingDefinitionV1,
  PluginSettingScopeV1,
  PluginSettingValueV1,
} from "@/contracts/generated/extensionContracts";
import {
  pluginDescription,
  pluginSettingsForScope,
  pluginSettingsTarget,
  pluginSettingsTargetsEqual,
  type DurePluginCatalogEntry,
  type DurePluginSettingsSnapshot,
  type DurePluginSettingsTargetV2,
} from "@/lib/plugins/durePlugins";
import {
  durePluginSettingsGet,
  durePluginSettingsUpdate,
} from "@/lib/ipc";
import { t } from "@/lib/i18n";

type ScopedSnapshots = Partial<
  Record<PluginSettingScopeV1, DurePluginSettingsSnapshot>
>;

function settingsValuesEqual(
  left: DurePluginSettingsSnapshot["values"],
  right: DurePluginSettingsSnapshot["values"],
): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
}

function validateSettingsSnapshotTarget(
  snapshot: DurePluginSettingsSnapshot,
  target: DurePluginSettingsTargetV2,
  scope: PluginSettingScopeV1,
  scopeKey: string | null | undefined,
): DurePluginSettingsSnapshot {
  const scopeKeyMatches =
    scopeKey === undefined
      ? scope === "workspace" &&
        typeof snapshot.scope_key === "string" &&
        snapshot.scope_key.length > 0
      : snapshot.scope_key === scopeKey;
  if (
    pluginSettingsTargetsEqual(snapshot.target, target) &&
    snapshot.scope === scope &&
    scopeKeyMatches
  ) {
    return snapshot;
  }
  throw new Error(
    t("sidebar.pluginSettings.responseMismatch"),
  );
}

function SettingControl({
  definition,
  value,
  disabled,
  onChange,
}: {
  definition: PluginSettingDefinitionV1;
  value: PluginSettingValueV1 | undefined;
  disabled: boolean;
  onChange: (value: PluginSettingValueV1) => void;
}) {
  if (definition.kind === "boolean") {
    return (
      <Switch
        size="sm"
        checked={typeof value === "boolean" ? value : definition.default}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={t(definition.title)}
      />
    );
  }
  if (definition.kind === "integer") {
    return (
      <Input
        type="number"
        className="w-20 text-right"
        min={definition.minimum}
        max={definition.maximum}
        value={typeof value === "number" ? value : definition.default}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={t(definition.title)}
      />
    );
  }
  return (
    // The selector fills its wrapper, so the slot fixes the width the bare
    // select used to cap at max-w-32.
    <div className="w-32 shrink-0">
      <SelectField
        value={typeof value === "string" ? value : definition.default}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue)}
        aria-label={t(definition.title)}
      >
        {definition.options.map((option) => (
          <SelectOption key={option.value} value={option.value}>
            {t(option.label)}
          </SelectOption>
        ))}
      </SelectField>
    </div>
  );
}

function SettingsGroup({
  title,
  definitions,
  snapshot,
  disabled,
  onChange,
}: {
  title: string;
  definitions: PluginSettingDefinitionV1[];
  snapshot: DurePluginSettingsSnapshot | undefined;
  disabled: boolean;
  onChange: (
    scope: PluginSettingScopeV1,
    key: string,
    value: PluginSettingValueV1,
  ) => void;
}) {
  if (definitions.length === 0) return null;
  return (
    <section className="border-t border-glass-hairline px-4 py-4 first:border-t-0">
      <h3 className="mb-3 text-[11px] leading-[18px] font-medium text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-4">
        {definitions.map((definition) => (
          <div
            key={definition.key}
            className="flex min-w-0 items-start gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {t(definition.title)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t(definition.description)}
              </div>
            </div>
            <SettingControl
              definition={definition}
              value={snapshot?.values[definition.key]}
              disabled={disabled || !snapshot}
              onChange={(value) =>
                onChange(definition.scope, definition.key, value)
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function DurePluginSettingsDialog({
  entry,
  open,
  onOpenChange,
  workspaceScopeKey,
  workspaceRoot = null,
}: {
  entry: DurePluginCatalogEntry | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceScopeKey: string | null;
  workspaceRoot?: string | null;
}) {
  const [snapshots, setSnapshots] = useState<ScopedSnapshots>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsContribution = entry?.settings_contribution;
  const settingsSchema = settingsContribution?.schema;
  const settingsTarget = entry ? pluginSettingsTarget(entry) : null;
  const hasSettings = settingsTarget !== null;
  const targetKey = JSON.stringify([
    open,
    settingsTarget,
    workspaceScopeKey,
    workspaceRoot,
    settingsContribution,
  ]);
  const currentTargetKey = useRef(targetKey);
  const operationGeneration = useRef(0);
  currentTargetKey.current = targetKey;

  useEffect(() => {
    let cancelled = false;
    const generation = ++operationGeneration.current;
    const expectedTargetKey = targetKey;
    const isCurrent = () =>
      !cancelled &&
      operationGeneration.current === generation &&
      currentTargetKey.current === expectedTargetKey;
    const invalidate = () => {
      cancelled = true;
      if (operationGeneration.current === generation) {
        operationGeneration.current += 1;
      }
    };
    setSaving(false);
    if (!open || !settingsTarget || !hasSettings) {
      setLoading(false);
      setError(null);
      setSnapshots({});
      return invalidate;
    }
    setLoading(true);
    setError(null);
    setSnapshots({});
    void Promise.all([
      durePluginSettingsGet(settingsTarget, "user"),
      workspaceRoot
        ? durePluginSettingsGet(
            settingsTarget,
            "workspace",
            workspaceScopeKey ?? undefined,
            workspaceRoot,
          )
        : workspaceScopeKey
          ? durePluginSettingsGet(
              settingsTarget,
              "workspace",
              workspaceScopeKey,
            )
        : Promise.resolve(null),
    ])
      .then(([user, workspace]) => {
        if (!isCurrent()) return;
        const userSnapshot = validateSettingsSnapshotTarget(
          user,
          settingsTarget,
          "user",
          null,
        );
        const workspaceSnapshot = workspace
          ? validateSettingsSnapshotTarget(
              workspace,
              settingsTarget,
              "workspace",
              workspaceRoot ? undefined : workspaceScopeKey,
            )
          : null;
        setSnapshots({
          user: userSnapshot,
          ...(workspaceSnapshot ? { workspace: workspaceSnapshot } : {}),
        });
      })
      .catch((settingsError) => {
        if (isCurrent()) setError(String(settingsError));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return invalidate;
  }, [hasSettings, open, settingsTarget, targetKey, workspaceScopeKey]);

  if (!entry) return null;

  const activeSettingsTarget = settingsTarget;
  const userDefinitions = settingsSchema
    ? pluginSettingsForScope(settingsSchema, "user")
    : [];
  const workspaceDefinitions = settingsSchema
    ? pluginSettingsForScope(settingsSchema, "workspace")
    : [];
  const title = `${entry.manifest.display_name} · ${t("sidebar.plugins.settingsTitle")}`;

  const saveSetting = async (
    scope: PluginSettingScopeV1,
    key: string,
    value: PluginSettingValueV1,
  ) => {
    if (!activeSettingsTarget) return;
    const current = snapshots[scope];
    if (!current || saving) return;
    const expectedScopeKey = scope === "workspace" ? current.scope_key : null;
    let validatedCurrent: DurePluginSettingsSnapshot;
    try {
      validatedCurrent = validateSettingsSnapshotTarget(
        current,
        activeSettingsTarget,
        scope,
        expectedScopeKey,
      );
    } catch (targetError) {
      setError(String(targetError));
      return;
    }
    const generation = operationGeneration.current;
    const expectedTargetKey = targetKey;
    const next = {
      ...validatedCurrent,
      values: { ...validatedCurrent.values, [key]: value },
    };
    setSnapshots((existing) => ({ ...existing, [scope]: next }));
    setSaving(true);
    setError(null);
    const invalidation = invalidatePluginSettingsSnapshot(validatedCurrent);
    let sharedSettled = invalidation === null;
    try {
      const saved =
        scope === "workspace"
          ? await durePluginSettingsUpdate(next, workspaceRoot ?? undefined)
          : await durePluginSettingsUpdate(next);
      const validated = validateSettingsSnapshotTarget(
        saved,
        activeSettingsTarget,
        scope,
        expectedScopeKey,
      );
      const receipt = publishPluginSettingsSnapshot(
        validated,
        invalidation ?? undefined,
      );
      sharedSettled = receipt.reason !== "conflict";
      if (
        operationGeneration.current !== generation ||
        currentTargetKey.current !== expectedTargetKey
      ) {
        return;
      }
      const winner = receipt.current ?? validated;
      setSnapshots((existing) => ({ ...existing, [scope]: winner }));
      if (receipt.reason === "conflict") {
        setError(t("sidebar.pluginSettings.responseMismatch"));
      }
    } catch (saveError) {
      let recoveredCommitted = false;
      let recoveredWinner: DurePluginSettingsSnapshot | null = null;
      try {
        if (invalidation) {
          const receipt = await revalidatePluginSettingsSnapshot(invalidation);
          sharedSettled =
            receipt.reason !== "conflict" &&
            receipt.reason !== "revalidation_failed";
          recoveredWinner = receipt.current;
          recoveredCommitted =
            receipt.candidateIsWinner &&
            receipt.current !== null &&
            settingsValuesEqual(receipt.current.values, next.values);
        } else {
          const recovered =
            scope === "workspace"
              ? await durePluginSettingsGet(
        activeSettingsTarget,
                  "workspace",
                  workspaceRoot
                    ? workspaceScopeKey ?? undefined
                    : validatedCurrent.scope_key ?? undefined,
                  workspaceRoot ?? undefined,
                )
              : await durePluginSettingsGet(activeSettingsTarget, scope);
          const validatedRecovery = validateSettingsSnapshotTarget(
            recovered,
            activeSettingsTarget,
        scope,
        expectedScopeKey,
      );
          const receipt = publishPluginSettingsSnapshot(validatedRecovery);
          recoveredWinner = receipt.current;
          recoveredCommitted =
            receipt.candidateIsWinner &&
            receipt.current !== null &&
            settingsValuesEqual(receipt.current.values, next.values);
        }
      if (
        operationGeneration.current !== generation ||
        currentTargetKey.current !== expectedTargetKey
      ) {
        return;
      }
        setSnapshots((existing) => ({
          ...existing,
          [scope]: recoveredWinner ?? validatedCurrent,
        }));
      } catch {
        if (
          operationGeneration.current === generation &&
          currentTargetKey.current === expectedTargetKey
        ) {
      setSnapshots((existing) => ({ ...existing, [scope]: validatedCurrent }));
        }
      }
      if (
        operationGeneration.current === generation &&
        currentTargetKey.current === expectedTargetKey &&
        !recoveredCommitted
      ) {
      setError(`${t("sidebar.pluginSettings.saveFailed")}: ${String(saveError)}`);
      }
    } finally {
      if (invalidation && !sharedSettled) {
        void revalidatePluginSettingsSnapshot(invalidation);
      }
      if (
        operationGeneration.current === generation &&
        currentTargetKey.current === expectedTargetKey
      ) {
        setSaving(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(44rem,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-2">
            <DialogTitle>{title}</DialogTitle>
            {saving && <DureLoader />}
          </div>
          <DialogDescription>
            {t(pluginDescription(entry))}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto rounded-[11px] border border-glass-hairline">
          {open && entry.manifest.id === "dure.slack" && <SlackTeamConnections />}
          {error && (
            <Alert
              icon={false}
              className="rounded-none border-b border-glass-hairline px-4 text-xs"
            >
              {error}
            </Alert>
          )}
          {entry.manifest.id === "dure.slack" ? null : entry.distribution === "bundled" && workspaceRoot ? (
            <PluginPermissionControls
              pluginName={entry.manifest.display_name}
              pluginId={entry.manifest.id}
              workspaceRoot={workspaceRoot}
            />
          ) : entry.distribution === "bundled" ? (
            <div className="border-t border-glass-hairline px-4 py-4 text-xs text-muted-foreground first:border-t-0">
              {t("sidebar.pluginSettings.permissionsHint")}
            </div>
          ) : null}
          {loading ? (
            <LoadingRow className="px-4 py-6">{t("common.loading")}</LoadingRow>
          ) : (
            <>
              <SettingsGroup
                title={t("sidebar.pluginSettings.userScope")}
                definitions={userDefinitions}
                snapshot={snapshots.user}
                disabled={saving}
                onChange={(scope, key, value) =>
                  void saveSetting(scope, key, value)
                }
              />
              {workspaceRoot || workspaceScopeKey ? (
                <SettingsGroup
                  title={t("sidebar.pluginSettings.workspaceScope")}
                  definitions={workspaceDefinitions}
                  snapshot={snapshots.workspace}
                  disabled={saving}
                  onChange={(scope, key, value) =>
                    void saveSetting(scope, key, value)
                  }
                />
              ) : (
                workspaceDefinitions.length > 0 && (
                  <div className="border-t border-glass-hairline px-4 py-4 text-xs text-muted-foreground">
                    {t("sidebar.pluginSettings.workspaceHint")}
                  </div>
                )
              )}
              {!settingsSchema && entry.manifest.id !== "dure.slack" && (
                <div className="border-t border-glass-hairline px-4 py-4 text-xs text-muted-foreground">
                  {t("sidebar.pluginSettings.noSettings")}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
