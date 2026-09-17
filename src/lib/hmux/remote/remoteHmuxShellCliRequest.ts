import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { handleRemoteHmuxShellHandoff } from "@/lib/hmux/remote/remoteHmuxShellHandoff";
import { RemoteHmuxShellRequestError } from "@/lib/hmux/remote/remoteHmuxShellRequest";
import type { RemoteShellHostDraft } from "@/lib/hmux/remote/remoteHmuxShellRegistration";

export interface CliRequest {
  reqId: string;
  action: string;
  params: Record<string, unknown>;
}

export async function handleRemoteHmuxShellCliRequest(
  reqId: string,
  params: Record<string, unknown>,
  claimRequest: (reqId: string) => Promise<boolean>,
  completeRequest: (
    reqId: string,
    result: unknown,
    action: string,
  ) => Promise<void>,
  decide?: (candidate: RemoteShellHostDraft) => Promise<boolean | null>,
): Promise<void> {
  let claimed = false;
  const claim = async () => {
    if (claimed) return true;
    claimed = await claimRequest(reqId);
    return claimed;
  };
  let result:
    | Awaited<ReturnType<typeof handleRemoteHmuxShellHandoff>>
    | {
        ok: false;
        error: { code: string; message: string };
      };
  try {
    result = await handleRemoteHmuxShellHandoff(params, claim, decide);
    if (result.unavailable === true) return;
    if (result.fallback === true && !(await claim())) return;
  } catch (error) {
    if (!(await claim())) return;
    result = {
      ok: false,
      error: {
        code:
          error instanceof PaneCommandError
            ? error.code
            : error instanceof RemoteHmuxShellRequestError
              ? error.code
              : "hmux_remote_shell_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  await completeRequest(reqId, result, "hmux.remote-shell");
}
