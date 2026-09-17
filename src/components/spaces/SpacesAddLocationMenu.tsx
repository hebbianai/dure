// The Spaces header's "add a project" entry: a folder-plus button that opens
// one menu with every way a working location gets registered — the folders
// this machine has already worked in (from provider conversation records, no
// disk crawl), the native local folder picker, each SSH host's remote
// browser, a new SSH host, and the full location manager. Picking a recent
// folder registers it in one click; everything else opens its own surface.
import {
  Folder,
  FolderGit2,
  FolderCog,
  FolderOpen,
  FolderPlus,
  Plus,
  Server,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  AddRemoteProjectDialog,
  AddSshHostDialog,
} from "@/components/ssh/SshHostDialogs";
import { useLocationAdd } from "@/components/spaces/useLocationAdd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { pathParentName } from "@/lib/files/paths";
import { t } from "@/lib/i18n";
import {
  ensureRecentSessionHistory,
  recentSessionHistoryScopeKey,
  recentSessionHistorySnapshot,
  subscribeRecentSessionHistory,
} from "@/lib/sessions/recentSessionHistoryResource";
import { localFolderSuggestions } from "@/lib/spaces/localFolderSuggestions";
import type { SshHostConfig } from "@/types";

/** Recent folders shown inline — enough to catch the repository you were in
 *  yesterday; the location manager lists the rest. */
const RECENT_FOLDER_LIMIT = 5;

/** Only this machine is scanned — a menu must never block on waking a
 *  sleeping remote. */
const LOCAL_ONLY: readonly SshHostConfig[] = [];
const LOCAL_SCOPE_KEY = recentSessionHistoryScopeKey(LOCAL_ONLY);
const localHistorySnapshot = () => recentSessionHistorySnapshot(LOCAL_SCOPE_KEY);

export function SpacesAddLocationMenu({
  onManageLocations,
}: {
  onManageLocations: () => void;
}) {
  const { projects, sshHosts, addFolder, pickLocalFolder } = useLocationAdd();
  const [open, setOpen] = useState(false);
  const [addingHost, setAddingHost] = useState(false);
  const [remoteHostId, setRemoteHostId] = useState<string | null>(null);
  // Provider records come from the shared recent-session-history resource —
  // one stale-while-revalidate read for every sidebar surface that wants
  // them. Opening the menu asks for it; a scan that finishes after the menu
  // closed is kept for the next open, and a failed one is retried once the
  // freshness window has passed.
  const history = useSyncExternalStore(
    subscribeRecentSessionHistory,
    localHistorySnapshot,
    localHistorySnapshot,
  );
  useEffect(() => {
    if (open) void ensureRecentSessionHistory(LOCAL_ONLY);
  }, [open]);
  const suggestions = useMemo(
    () =>
      localFolderSuggestions({
        records: history.entries,
        // A remote location at the same path does not hide the local folder.
        registeredPaths: projects
          .filter((project) => project.kind === "local")
          .map((project) => project.path),
        limit: RECENT_FOLDER_LIMIT,
      }),
    [history.entries, projects],
  );
  const loadingRecents =
    open && history.loadState === "loading" && history.entries.length === 0;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton title={t("spaces.locations.add")}>
            <FolderPlus />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          // Down-right from the button, like every header icon-button menu
          // (HoverMenuButton's rule; owner decision 2026-09-10). It used to hang
          // right-aligned while the plus beside it opened the other way.
          align="start"
          collisionPadding={8}
          className="w-64"
        >
          {(loadingRecents || suggestions.length > 0) && (
            <>
              <DropdownMenuLabel>
                {loadingRecents
                  ? t("spaces.locations.recentProjectsLoading")
                  : t("spaces.locations.recentProjects")}
              </DropdownMenuLabel>
              {suggestions.map((suggestion) => (
                <DropdownMenuItem
                  key={suggestion.path}
                  title={suggestion.path}
                  onSelect={() => void addFolder(suggestion.path)}
                >
                  {suggestion.isRepo ? <FolderGit2 /> : <Folder />}
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {suggestion.name}
                  </span>
                  <span className="max-w-[40%] shrink-0 truncate font-mono text-meta text-muted-foreground">
                    {pathParentName(suggestion.path)}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => void pickLocalFolder()}>
            <FolderOpen />
            <span className="text-xs">{t("spaces.locations.openLocalFolder")}</span>
          </DropdownMenuItem>
          {sshHosts.map((host) => (
            <DropdownMenuItem
              key={host.id}
              onSelect={() => setRemoteHostId(host.id)}
            >
              <Server />
              <span className="min-w-0 truncate text-xs">
                {t("spaces.locations.openFromHost", { name: host.name })}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setAddingHost(true)}>
            <Plus />
            <span className="text-xs">{t("spaces.locations.addSshHost")}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManageLocations}>
            <FolderCog />
            <span className="text-xs">{t("spaces.locations.manage")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {addingHost && <AddSshHostDialog onClose={() => setAddingHost(false)} />}
      {remoteHostId && (
        <AddRemoteProjectDialog
          hostId={remoteHostId}
          onClose={() => setRemoteHostId(null)}
        />
      )}
    </>
  );
}
