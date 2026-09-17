import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localBackendServiceEnvironment } from "../cli/lib/local-backend-environment.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "backend-provider-path-"));
  roots.push(root);
  for (const name of ["npm", "standalone", "home"]) mkdirSync(join(root, name));
  for (const name of ["npm", "standalone"]) {
    writeFileSync(join(root, name, "codex"), `#!/bin/sh\nprintf '${name}\\n'\n`, { mode: 0o700 });
  }
  const shell = join(root, "login-shell");
  writeFileSync(shell, '#!/bin/sh\n[ "$1" = -lc ] || exit 9\nexport PATH="$LOGIN_PROVIDER_PATH"\nexport CODEX_HOME=/untrusted-shell-home\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  return {
    root,
    environment: {
      HOME: join(root, "home"), CODEX_HOME: join(root, "codex"),
      CODEX_SQLITE_HOME: join(root, "canonical"), DURE_HOME: join(root, "dure"),
      HMUX_DISCOVERY_ROOT: join(root, "discovery"), DURE_HMUX_BIN: "/exact/hmux",
      DURE_APP_CHANNEL: "qa-path", SHELL: shell,
      PATH: `${join(root, "npm")}:/usr/bin:/bin`,
      LOGIN_PROVIDER_PATH: `${join(root, "standalone")}:/usr/bin:/bin`,
    },
  };
}

describe.skipIf(process.platform === "win32")("local backend provider environment", () => {
  it("launches the login-shell provider instead of an inherited second installation", () => {
    const { environment } = fixture();
    const inherited = spawnSync("/usr/bin/env", ["codex"], { env: environment, encoding: "utf8" });
    expect(inherited.stdout.trim()).toBe("npm");
    const launchEnvironment = localBackendServiceEnvironment(environment);
    const launched = spawnSync("/usr/bin/env", ["codex"], { env: launchEnvironment, encoding: "utf8" });
    expect(launched.status).toBe(0);
    expect(launched.stdout.trim()).toBe("standalone");
    expect(launchEnvironment.CODEX_HOME).toBe(environment.CODEX_HOME);
    expect(launchEnvironment.CODEX_SQLITE_HOME).toBe(environment.CODEX_SQLITE_HOME);
    expect(launchEnvironment.DURE_APP_CHANNEL).toBe("qa-path");
    expect(launchEnvironment.HMUX_DISCOVERY_ROOT).toBeUndefined();
    expect(launchEnvironment.DURE_HMUX_BIN).toBeUndefined();
    expect(environment.PATH).toContain("/npm:");
  });

  it("refuses a failed login-shell probe without choosing the inherited provider", () => {
    const { environment } = fixture();
    writeFileSync(environment.SHELL, "#!/bin/sh\nexit 7\n");
    expect(() => localBackendServiceEnvironment(environment)).toThrowError(
      expect.objectContaining({ code: "local_backend_login_environment_unavailable" }),
    );
  });

  it("refuses a successful probe that did not return a provider PATH", () => {
    const { environment } = fixture();
    writeFileSync(environment.SHELL, "#!/bin/sh\nprintf 'HOME=/other\\0'\n");
    expect(() => localBackendServiceEnvironment(environment)).toThrowError(
      expect.objectContaining({ code: "local_backend_login_environment_unavailable" }),
    );
  });

  it("keeps Windows on its inherited executable environment", () => {
    const { environment } = fixture();
    writeFileSync(environment.SHELL, "#!/bin/sh\nexit 7\n");
    expect(localBackendServiceEnvironment(environment, "win32").PATH).toBe(environment.PATH);
  });
});
