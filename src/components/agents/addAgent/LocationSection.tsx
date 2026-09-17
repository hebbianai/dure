// 위치 섹션 (시안 2256:29029~29052) — 프로젝트 셀렉트 + '최근' 칩.

import { Folder, FolderPlus } from "lucide-react";
import { SelectButton } from "@/components/ui/select";
import { Titled } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { Project } from "@/types";
import { EnvironmentLauncher } from "./EnvironmentLauncher";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";

export function LocationSection({
  projects,
  selected,
  recents,
  homePath,
  onSelect,
  onBrowse,
  onEnvironmentReady,
}: {
  projects: readonly Project[];
  selected: Project | null;
  recents: readonly Project[];
  /** Local Home may be offered before it becomes a registered Project. */
  homePath?: string;
  onSelect: (project: Project) => void;
  /** 목록에 없는 폴더 고르기 — 로컬은 네이티브 선택, 원격은 SSH 브라우저 */
  onBrowse: () => void;
  onEnvironmentReady?: (project: Project) => void;
}) {
  const mode = useInterfaceMode();
  const label = (project: Project) =>
    project.kind === "local" && project.path === homePath
      ? t("agents.location.home")
      : project.name;

  return (
    <div className="flex w-full flex-col gap-2">
      {/* 2256:29031 라벨 줄 — 오른쪽에 폴더 추가 */}
      <div className="flex w-full items-start gap-1.5">
        <span className="min-w-0 flex-1 text-xs leading-4 font-medium text-foreground">
          {t("common.location")}
        </span>
        <IconButton
          onClick={onBrowse}
          title={t("agents.location.chooseAnotherFolder")}
          className="hover:bg-glass-tint-hover"
        >
          <FolderPlus />
        </IconButton>
      </div>

      {/* An empty host has no select options. Keep the same location surface,
          but make it the entry point to the host-aware folder browser. */}
      <div className="relative w-full">
        {projects.length === 0 ? (
          <SelectButton
            aria-label={t("common.location")}
            onClick={onBrowse}
            className="w-full text-muted-foreground"
          >
            <Folder className="size-3.5" />
            <span data-slot="select-value">{t("agents.location.chooseFolder")}</span>
          </SelectButton>
        ) : (
          <SelectField
            value={selected?.id ?? ""}
            onValueChange={(nextValue) => {
              const next = projects.find((p) => p.id === nextValue);
              if (next) onSelect(next);
            }}
            aria-label={t("common.location")}
            leadingIcon={<Folder className="size-3.5 text-muted-foreground" />}
            className={selected ? undefined : "text-muted-foreground"}
            display={
              selected ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{label(selected)}</span>
                  <Titled title={selected.path}>
                    <span
                      className="ml-auto max-w-[55%] truncate text-meta text-muted-foreground"
                    >
                      {selected.kind === "local" && selected.path === homePath
                        ? "~"
                        : selected.path}
                    </span>
                  </Titled>
                </span>
              ) : undefined
            }
          >
            {!selected && (
              <SelectOption value="">{t("agents.location.chooseFolder")}</SelectOption>
            )}
            {projects.map((project) => (
              <SelectOption key={project.id} value={project.id}>
                {label(project)}
              </SelectOption>
            ))}
          </SelectField>
        )}
      </div>

      {mode === "pro" && selected?.kind === "local" && selected.isRepo && onEnvironmentReady && (
        <EnvironmentLauncher key={selected.id} project={selected} onReady={onEnvironmentReady} />
      )}

      {/* 2256:29046 Tag Section — 최근 위치 칩 */}
      {recents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="pr-2 text-meta leading-4 font-medium text-muted-foreground">
            {t("agents.location.recent")}
          </span>
          {recents.map((project) => {
            const active = project.id === selected?.id;
            return (
              <Titled key={project.id} title={project.path}>
                <button
                  type="button"
                  onClick={() => onSelect(project)}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-md border border-border px-3 shadow-xs",
                    active
                      ? "bg-glass-sheet text-foreground"
                      : "text-muted-foreground hover:bg-glass-tint-hover",
                  )}
                >
                  <Folder className="size-3 shrink-0" />
                  <span className="max-w-[120px] truncate text-meta leading-4 font-medium">
                    {label(project)}
                  </span>
                </button>
              </Titled>
            );
          })}
        </div>
      )}
    </div>
  );
}
