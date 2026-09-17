// 고급 섹션 (시안 2256:29166~29181) — 접힘/펼침 두 상태가 각각 시안 29002/29090.

import { t } from "@/lib/i18n";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { launchPermissionDescription } from "@/lib/agents/providerPermissions";
import {
  WORKTREE_ROOTS,
  permissionToOverride,
  type AgentPermission,
  type WorktreeRoot,
} from "@/lib/agents/addAgentForm";

/** 라벨 + 설명 + 오른쪽 컨트롤 한 줄 (시안 2256:29172 Header). */
function Row({
  label,
  description,
  control,
}: {
  label: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs leading-none font-medium text-foreground">{label}</span>
        <span className="text-meta leading-4 text-muted-foreground">{description}</span>
      </div>
      {control}
    </div>
  );
}

function MiniSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="w-[180px] shrink-0">
      <SelectField
        aria-label={label}
        value={value}
        onValueChange={(nextValue) => onChange(nextValue)}
      >
        {options.map((option) => (
          <SelectOption key={option.value} value={option.value}>
            {option.label}
          </SelectOption>
        ))}
      </SelectField>
    </div>
  );
}

export function AdvancedSection({
  open,
  onToggle,
  baseRef,
  baseRefOptions,
  onBaseRefChange,
  worktreeRoot,
  onWorktreeRootChange,
  permission,
  onPermissionChange,
  credentialId,
  credentialOptions,
  onCredentialChange,
  showWorktreeCreationOptions,
  runSetup,
  onRunSetupChange,
  setupHint,
}: {
  open: boolean;
  onToggle: () => void;
  baseRef: string;
  baseRefOptions: readonly string[];
  onBaseRefChange: (value: string) => void;
  worktreeRoot: WorktreeRoot;
  onWorktreeRootChange: (value: WorktreeRoot) => void;
  permission: AgentPermission;
  onPermissionChange: (value: AgentPermission) => void;
  credentialId: string | null;
  /** undefined면 이 provider는 안전한 per-process 계정 선택을 지원하지 않는다. */
  credentialOptions?: readonly { value: string; label: string }[];
  onCredentialChange: (value: string | null) => void;
  /** Existing checkout reuse must not branch, relocate, or run setup in WIP. */
  showWorktreeCreationOptions: boolean;
  runSetup: boolean;
  onRunSetupChange: (value: boolean) => void;
  /** 이 워크트리에서 실제로 돌 명령 — 없으면 돌릴 게 없다는 뜻 */
  setupHint: string | null;
}) {
  const PERMISSION_LABELS: Record<AgentPermission, string> = {
    inherit: t("common.systemDefault"),
    ask: t("agents.chat.permissionDefault"),
    write: t("agents.chat.permissionSkip"),
  };
  return (
    <div className="flex w-full flex-col gap-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2"
      >
        <span className="text-xs leading-4 font-medium text-foreground">{t("common.advanced")}</span>
        <DisclosureChevron open={open} orientation="down-up" />
      </button>

      {open && (
        <div className="flex w-full flex-col gap-4">
          {credentialOptions && (
            <Row
              label={t("agents.account.credential")}
              description={t("agents.account.pinnedFromFirstRun")}
              control={
                <MiniSelect
                  label={t("agents.account.credential")}
                  value={credentialId ?? ""}
                  options={[
                    { value: "", label: t("agents.account.defaultCli") },
                    ...credentialOptions,
                  ]}
                  onChange={(value) => onCredentialChange(value || null)}
                />
              }
            />
          )}
          {/* The mockup labels this 'Language', but the description and value (Main)
              describe the fork base — treat it as a mockup labeling mistake and keep
              the existing 'Base' concept. */}
          {showWorktreeCreationOptions && (
            <>
              <Row
                label={t("agents.worktree.base")}
                description={t("agents.worktree.baseDescription")}
                control={
                  <MiniSelect
                    label={t("agents.worktree.base")}
                    value={baseRef}
                    options={baseRefOptions.map((value) => ({ value, label: value }))}
                    onChange={onBaseRefChange}
                  />
                }
              />
              <Row
                label={t("agents.worktree.location")}
                description={t("agents.worktree.locationDefaultHint")}
                control={
                  <MiniSelect
                    label={t("agents.worktree.location")}
                    value={worktreeRoot}
                    options={WORKTREE_ROOTS.map((value) => ({ value, label: value }))}
                    onChange={(value) => onWorktreeRootChange(value as WorktreeRoot)}
                  />
                }
              />
            </>
          )}
          <Row
            label={t("agents.permission.title")}
            description={launchPermissionDescription(permissionToOverride(permission) ?? "inherit")}
            control={
              <MiniSelect
                label={t("agents.permission.title")}
                value={permission}
                options={[
                  { value: "inherit", label: PERMISSION_LABELS.inherit },
                  { value: "ask", label: PERMISSION_LABELS.ask },
                  { value: "write", label: PERMISSION_LABELS.write },
                ]}
                onChange={(value) => onPermissionChange(value as AgentPermission)}
              />
            }
          />
          {showWorktreeCreationOptions && (
            <Row
              label={t("agents.worktree.runSetupAfterCreate")}
              // 무엇이 돌지 실제 명령으로 보여 준다 — 시안은 예시 두 개를 나열하지만
              // 저장소마다 다르고, 돌릴 게 없으면 없다고 말해야 한다.
              description={setupHint ?? t("agents.worktree.noSetupFound")}
              control={
                <Switch
                  checked={runSetup && setupHint !== null}
                  disabled={setupHint === null}
                  onCheckedChange={onRunSetupChange}
                  aria-label={t("agents.worktree.runSetupAfterCreate")}
                />
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
