import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerFromCommand } from "@/lib/agents/providers";
import { PROVIDERS, type Provider } from "@/types";

const SAMPLER_SOURCE = "crates/hebbian-process-sampler/src/lib.rs";

/** 프로세스 샘플러(로컬·원격 공통)가 프로세스 트리에서 찾는 실행 파일 목록.
 *  샘플러는 프로바이더 id를, 명령줄 경로에서는 실행 파일 이름을 넘겨주는데 앱이
 *  둘 다 매핑해야 한다 — 목록이 어긋나면 에이전트를 켜도 로고가 안 뜬다. */
function samplerBinaries(): string[] {
  const source = readFileSync(SAMPLER_SOURCE, "utf8");
  const block = source.match(/const AGENT_BINARIES: &\[AgentBinary\] = &\[([\s\S]*?)\];/)?.[1];
  if (!block) throw new Error(`AGENT_BINARIES를 ${SAMPLER_SOURCE}에서 찾지 못했습니다`);
  // `binary_with(..., "acli", "rovodev")`의 세 번째 인자는 명령줄에서 함께 있어야 하는
  // 토큰일 뿐 프로세스 이름이 아니다 — 실행 파일 이름(두 번째 인자)만 뽑는다.
  const entries = [...block.matchAll(/binary(?:_with)?\(\s*AgentProvider::\w+\s*,\s*"([^"]+)"/g)];
  if (entries.length === 0) throw new Error(`AGENT_BINARIES 항목을 해석하지 못했습니다`);
  return entries.map((m) => m[1]);
}

/** 샘플러가 프레임에 싣는 프로바이더 id (`AgentProvider::as_str`). */
function samplerProviderIds(): string[] {
  const source = readFileSync(SAMPLER_SOURCE, "utf8");
  const block = source.match(/pub fn as_str\(self\) -> &'static str \{([\s\S]*?)\n {4}\}/)?.[1];
  if (!block) throw new Error(`as_str 매핑을 ${SAMPLER_SOURCE}에서 찾지 못했습니다`);
  return [...block.matchAll(/=> "([^"]+)"/g)].map((m) => m[1]);
}

/** 앱이 아는 실행 파일 이름 — 실행 명령의 첫 낱말 + 추가 감지 이름. */
function appBinaries(): { provider: Provider; name: string }[] {
  return (Object.keys(PROVIDERS) as Provider[]).flatMap((provider) => {
    const spec = PROVIDERS[provider];
    return [spec.cmd.split(" ")[0], ...(spec.detectNames ?? [])].map((name) => ({
      provider,
      name,
    }));
  });
}

describe("프로세스 이름 → 프로바이더", () => {
  it("샘플러가 찾는 실행 파일은 전부 프로바이더로 매핑된다", () => {
    const unmapped = samplerBinaries().filter((name) => !providerFromCommand(name));
    expect(unmapped).toEqual([]);
  });

  it("샘플러가 프레임에 싣는 프로바이더 id도 전부 매핑된다", () => {
    const unmapped = samplerProviderIds().filter((id) => !providerFromCommand(id));
    expect(unmapped).toEqual([]);
  });

  it("앱이 아는 실행 파일은 샘플러도 찾을 수 있다", () => {
    // codex는 보조 실행 파일(codex-*)까지 잡으려고 샘플러가 접두사로 따로 처리한다.
    const sampler = new Set([...samplerBinaries(), "codex"]);
    const missing = appBinaries()
      .filter(({ name }) => !sampler.has(name))
      .map(({ provider, name }) => `${provider}:${name}`);
    expect(missing).toEqual([]);
  });

  it("문서에서 확인한 실행 파일 이름으로 매핑된다", () => {
    // 패키지 이름과 실행 파일이 다른 것들 — 여기서 틀리면 감지가 통째로 빗나간다.
    expect(providerFromCommand("agy")).toBe("antigravity");
    expect(providerFromCommand("kilo")).toBe("kilocode");
    expect(providerFromCommand("omp")).toBe("oh-my-pi");
    expect(providerFromCommand("cn")).toBe("continue");
    expect(providerFromCommand("crush")).toBe("charm");
    expect(providerFromCommand("qwen")).toBe("qwen-code");
    expect(providerFromCommand("vibe")).toBe("mistral-vibe");
    expect(providerFromCommand("acli")).toBe("rovo-dev");
    expect(providerFromCommand("cursor-agent")).toBe("cursor");
    expect(PROVIDERS.kiro.cmd).toBe("kiro-cli");
  });

  it("절대경로로 와도 파일명만 본다", () => {
    expect(providerFromCommand("/opt/homebrew/bin/opencode")).toBe("opencode");
  });

  it("셸이나 모르는 프로세스는 매핑하지 않는다", () => {
    expect(providerFromCommand("zsh")).toBeNull();
    expect(providerFromCommand("ssh")).toBeNull();
    expect(providerFromCommand("")).toBeNull();
  });
});
