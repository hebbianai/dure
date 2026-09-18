import { expect, it, vi } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

it.each(["status", "install"])("runtime %s targets the selected backend without a resource or checkout", async (action) => {
  const requestBackend = vi.fn(async () => ({ result: { result: { state: "installing" } } }));
  const resolveBackend = vi.fn(async () => ({ profile: { id: "remote" } }));
  expect(await collectBrowserCommand({ args: ["runtime", action, "--backend", "remote"], requestBackend, resolveBackend })).toMatchObject({ ok: true, result: { state: "installing" } });
  expect(resolveBackend).toHaveBeenCalledWith({ backend: "remote", backendSpecified: true });
  expect(requestBackend.mock.calls[0][1].body).toEqual({ kind: `runtime_${action}` });
});

it("rejects resource and input options before requesting installation", async () => {
  for (const tail of [["--resource", "browser:one"], ["--controller", "agent"], ["extra"]]) {
    const resolveBackend = vi.fn();
    expect(await collectBrowserCommand({ args: ["runtime", "install", ...tail], resolveBackend })).toMatchObject({ ok: false, error: { code: "browser_command_invalid" } });
    expect(resolveBackend).not.toHaveBeenCalled();
  }
});

it.each(["failed", "unsupported"])("reports installation %s as unsuccessful", async (state) => {
  expect(await collectBrowserCommand({ args: ["runtime", "status"], resolveBackend: async () => ({ profile: { id: "local" } }), requestBackend: async () => ({ result: { result: { state } } }) })).toMatchObject({ ok: false, result: { state } });
});
