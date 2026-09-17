import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  planSetupLaunch,
  probeSetupCommand,
  resolveSetupCommand,
  setupProbeDirectories,
  setupProbePaths,
  setupShellCommand,
} from "./setupRun";

describe("resolveSetupCommand", () => {
  it("돌릴 것이 없으면 null — 빈 명령으로 터미널만 열지 않는다", () => {
    expect(resolveSetupCommand({ files: [] })).toBeNull();
    expect(resolveSetupCommand({ files: ["README.md"] })).toBeNull();
  });

  it("락파일을 보고 패키지 매니저를 고른다", () => {
    expect(resolveSetupCommand({ files: ["pnpm-lock.yaml"] })?.command).toBe("pnpm install");
    expect(resolveSetupCommand({ files: ["yarn.lock"] })?.command).toBe("yarn install");
    expect(resolveSetupCommand({ files: ["bun.lockb"] })?.command).toBe("bun install");
    expect(resolveSetupCommand({ files: ["Cargo.toml"] })?.command).toBe("cargo fetch");
  });

  it("락파일이 없고 package.json만 있으면 npm으로 떨어진다", () => {
    expect(resolveSetupCommand({ files: ["package.json"] })?.command).toBe("npm install");
  });

  it("락파일이 여럿이면 우선순위 앞의 것을 쓴다 — 잘못된 매니저가 락파일을 건드리면 안 된다", () => {
    const command = resolveSetupCommand({
      files: ["package-lock.json", "pnpm-lock.yaml", "package.json"],
    });
    expect(command?.command).toBe("pnpm install");
  });

  /** 이 규칙이 이 모듈의 핵심이다 — 둘 다 돌리면 중복이거나 위험하다. */
  it("저장소가 setup 스크립트를 정의했으면 그것만 돌린다", () => {
    const command = resolveSetupCommand({
      files: [".dure/setup.sh", "pnpm-lock.yaml"],
    });
    expect(command?.command).toBe("sh .dure/setup.sh");
    // install을 덧붙이지 않는다: 스크립트가 이미 install을 포함할 수 있고,
    // 우리가 먼저 돌리면 중복이거나 다른 매니저로 락파일을 건드린다.
    expect(command?.command).not.toContain("install");
  });

  it("기존 .hebbian setup은 canonical 파일이 없을 때만 읽는다", () => {
    expect(
      resolveSetupCommand({ files: [".hebbian/setup.sh", "pnpm-lock.yaml"] })?.command,
    ).toBe("sh .hebbian/setup.sh");
    expect(
      resolveSetupCommand({ files: [".hebbian/setup.sh", ".dure/setup.sh"] })?.command,
    ).toBe("sh .dure/setup.sh");
  });

  it("고른 이유를 함께 돌려준다 — 왜 이 명령인지 사용자가 알아야 한다", () => {
    expect(resolveSetupCommand({ files: ["pnpm-lock.yaml"] })?.reason).toContain(
      "pnpm-lock.yaml",
    );
  });
});

describe("setupProbePaths", () => {
  it("판정에 쓰는 파일을 전부 노출한다 — 호출부가 이 목록만 확인하면 된다", () => {
    const paths = setupProbePaths();
    expect(paths[0]).toBe(".dure/setup.sh");
    expect(paths).toContain(".hebbian/setup.sh");
    expect(paths).toContain("pnpm-lock.yaml");
    // 목록에 없는 파일을 판정이 몰래 보면 호출부의 탐색이 새게 된다.
    for (const file of ["package.json", "Cargo.toml", "go.mod", "uv.lock"]) {
      expect(paths).toContain(file);
    }
  });

  it("하위 setup 탐색 디렉터리를 canonical/compatibility 경계에서 제공한다", () => {
    expect(setupProbeDirectories()).toEqual([".dure", ".hebbian"]);
  });
});

describe("planSetupLaunch", () => {
  const base = {
    runSetup: true,
    createdWorktree: true,
    command: "pnpm install",
    cwd: "/repo/.worktrees/feature",
    host: null,
  };

  it("켜져 있고 돌릴 것이 있으면 그 워크트리에서 돈다", () => {
    expect(planSetupLaunch(base)).toEqual({
      command: "pnpm install",
      cwd: "/repo/.worktrees/feature",
      host: null,
    });
  });

  it("스위치가 꺼져 있으면 열지 않는다", () => {
    expect(planSetupLaunch({ ...base, runSetup: false })).toBeNull();
  });

  /** 빈 명령으로 pane만 띄우면 사용자는 뭔가 실패했다고 읽는다. */
  it("돌릴 명령이 없으면 열지 않는다", () => {
    expect(planSetupLaunch({ ...base, command: null })).toBeNull();
    expect(planSetupLaunch({ ...base, command: "   " })).toBeNull();
  });

  it("작업 디렉터리를 모르면 열지 않는다 — 엉뚱한 곳에서 install이 돌면 안 된다", () => {
    expect(planSetupLaunch({ ...base, cwd: "" })).toBeNull();
    expect(planSetupLaunch({ ...base, cwd: "  " })).toBeNull();
  });

  it("원격 프로젝트면 그 호스트를 함께 실어 보낸다", () => {
    const launch = planSetupLaunch({ ...base, host: { id: "h1", name: "v3_dh" } });
    expect(launch?.host).toEqual({ id: "h1", name: "v3_dh" });
  });
});

describe("planSetupLaunch — 워크트리를 만들지 않은 경우", () => {
  /** cwd가 사용자의 본 체크아웃이 되므로, 요청하지도 않은 install이 거기서
   *  돌면 안 된다. 스위치는 접힌 고급 섹션 안이라 봤으리라 가정할 수 없다. */
  it("전용 워크트리가 없으면 켜져 있어도 열지 않는다", () => {
    expect(
      planSetupLaunch({
        runSetup: true,
        createdWorktree: false,
        command: "pnpm install",
        cwd: "/repo",
        host: null,
      }),
    ).toBeNull();
  });
});

describe("setupShellCommand", () => {
	it("실행 명령 앞에 node 핀 해석 프리앰블을 붙인다 (표시는 원 명령 그대로)", () => {
		const shell = setupShellCommand("pnpm install");
		expect(shell.endsWith("pnpm install")).toBe(true);
		// 핀 파일 두 종과 로컬 설치본 후보 두 곳(nvm·mise)을 본다.
		expect(shell).toContain(".node-version");
		expect(shell).toContain(".nvmrc");
		expect(shell).toContain("/.nvm/versions/node/v$v/bin");
		expect(shell).toContain("/.local/share/mise/installs/node/$v/bin");
		// 매칭이 없으면 PATH를 건드리지 않고 원 명령이 그대로 돈다.
		expect(shell).toContain('if [ -x "$b/node" ]');
	});
});

describe("setupShellCommand package manager resolution", () => {
	// Runs the real preamble through /bin/sh so the assertion is about behavior,
	// not about the shell text. The backend PATH can be a bare login-shell PATH
	// without pnpm (2026-09-11 claude-19: "/bin/sh: pnpm: command not found").
	function runSetup(command: string, env: Record<string, string>) {
		const result = spawnSync("/bin/sh", ["-c", setupShellCommand(command)], {
			cwd: env.HOME,
			env,
			encoding: "utf8",
		});
		return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
	}
	function fakeBin(dir: string, name: string, body: string) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${dir}/${name}`, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}

	it("falls back to corepack when pnpm is absent from PATH", () => {
		const home = fs.mkdtempSync(`${os.tmpdir()}/setup-home-`);
		const bin = `${home}/bin`;
		fakeBin(bin, "corepack", 'printf "corepack %s\\n" "$*"');
		const result = runSetup("pnpm install", { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
		expect(result).toEqual({ status: 0, stdout: "corepack pnpm install", stderr: "" });
	});

	it("prefers a pnpm home install over corepack", () => {
		const home = fs.mkdtempSync(`${os.tmpdir()}/setup-home-`);
		const bin = `${home}/bin`;
		fakeBin(bin, "corepack", 'printf "corepack %s\\n" "$*"');
		fakeBin(`${home}/Library/pnpm`, "pnpm", 'printf "home pnpm %s\\n" "$*"');
		const result = runSetup("pnpm install", { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
		expect(result).toEqual({ status: 0, stdout: "home pnpm install", stderr: "" });
	});

	it("leaves a pnpm already on PATH alone", () => {
		const home = fs.mkdtempSync(`${os.tmpdir()}/setup-home-`);
		const bin = `${home}/bin`;
		fakeBin(bin, "pnpm", 'printf "path pnpm %s\\n" "$*"');
		fakeBin(`${home}/Library/pnpm`, "pnpm", 'printf "home pnpm %s\\n" "$*"');
		const result = runSetup("pnpm install", { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
		expect(result).toEqual({ status: 0, stdout: "path pnpm install", stderr: "" });
	});
});

describe("probeSetupCommand", () => {
  it("finds a lockfile install command from the top-level listing", async () => {
    const list = async (path: string) =>
      path === "/repo/a" ? [{ name: "pnpm-lock.yaml" }] : [];
    expect(await probeSetupCommand(list, "/repo/a")).toBe("pnpm install");
  });

  it("degrades to null when listing throws", async () => {
    const list = async () => {
      throw new Error("nope");
    };
    expect(await probeSetupCommand(list, "/repo/a")).toBeNull();
  });

  it("finds a nested setup.sh under a probe directory", async () => {
    const list = async (path: string) => {
      if (path === "/repo/a") return [{ name: ".dure" }];
      if (path === "/repo/a/.dure") return [{ name: "setup.sh" }];
      return [];
    };
    expect(await probeSetupCommand(list, "/repo/a")).toBe("sh .dure/setup.sh");
  });

  it("returns null when nothing matches", async () => {
    const list = async () => [{ name: "README.md" }];
    expect(await probeSetupCommand(list, "/repo/a")).toBeNull();
  });
});
