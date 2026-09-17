// Adding a working location from anywhere in the Spaces cluster. The native
// folder picker and a known folder path share one registration call and one
// error path, so the location manager and the pane header's add menu cannot
// drift apart in what "add this folder" means.
import {
  message as messageDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

export function useLocationAdd() {
  const projects = useStore((state) => state.projects);
  const sshHosts = useStore((state) => state.sshHosts);
  const addLocalProject = useStore((state) => state.addLocalProject);

  /** Register a folder the user already named (a recent-folder suggestion). */
  const addFolder = useCallback(
    async (path: string) => {
      try {
        await addLocalProject(path);
      } catch (error) {
        // The folder a record pointed at may have been deleted or moved — say
        // why it could not be opened, with the path.
        await messageDialog(
          t("spaces.locations.openFolderFailed", { path, e: String(error) }),
          { kind: "error" },
        );
      }
    },
    [addLocalProject],
  );

  /** Native folder picker, then the same registration. */
  const pickLocalFolder = useCallback(async () => {
    try {
      const directory = await openDialog({
        directory: true,
        multiple: false,
        title: t("common.chooseWorkingFolder"),
      });
      if (typeof directory === "string") return await addLocalProject(directory);
    } catch (error) {
      await messageDialog(t("common.folderOpenFailed", { e: String(error) }), {
        kind: "error",
      });
    }
  }, [addLocalProject]);

  return { projects, sshHosts, addFolder, pickLocalFolder };
}
