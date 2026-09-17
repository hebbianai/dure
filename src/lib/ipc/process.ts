import { invoke } from "@tauri-apps/api/core";
import type { ExecResult } from "@/lib/ipc/hmuxContracts";

/** Native shell execution. Callers own command construction and exit policy. */
export const runShell = (cmd: string) => invoke<ExecResult>("run_shell", { cmd });
