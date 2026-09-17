// ci-tool-cache.sh 동작 검증 — file:// 픽스처로 실제 bash+curl 경로를 태운다.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./ci-tool-cache.sh", import.meta.url));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-tool-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(url, sha, out, env = {}) {
  return spawnSync("bash", [SCRIPT, url, sha, out], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEBBIAN_CI_TOOL_CACHE_ROOT: join(dir, "cache"),
      HEBBIAN_CI_TOOL_CACHE_ALLOW_FILE: "1",
      ...env,
    },
  });
}

function fixture(content) {
  const source = join(dir, "artifact.bin");
  writeFileSync(source, content);
  const sha = createHash("sha256").update(content).digest("hex");
  return { url: `file://${source}`, sha, source };
}

describe("ci-tool-cache.sh", () => {
  it("미스 → 저장, 히트 → 재다운로드 없이 복사", () => {
    const { url, sha, source } = fixture("tool-bytes-v1");
    const out1 = join(dir, "out1.bin");
    const first = run(url, sha, out1);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("stored");
    expect(readFileSync(out1, "utf8")).toBe("tool-bytes-v1");

    // 원본을 지워도 히트 경로는 성공해야 한다(다운로드 안 함 증명).
    rmSync(source);
    const out2 = join(dir, "out2.bin");
    const second = run(url, sha, out2);
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("hit");
    expect(readFileSync(out2, "utf8")).toBe("tool-bytes-v1");
  });

  it("SHA 불일치 다운로드는 실패하고 캐시에 남기지 않는다", () => {
    const { url } = fixture("tool-bytes-v1");
    const wrongSha = createHash("sha256").update("other").digest("hex");
    const result = run(url, wrongSha, join(dir, "out.bin"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sha256 verification");
    const cached = spawnSync("ls", [join(dir, "cache")], { encoding: "utf8" });
    expect(cached.stdout.trim()).toBe("");
  });

  it("손상된 캐시 엔트리는 재다운로드로 교체한다", () => {
    const { url, sha } = fixture("tool-bytes-v1");
    const entry = join(dir, "cache", sha);
    run(url, sha, join(dir, "warm.bin"));
    writeFileSync(entry, "corrupted");
    const result = run(url, sha, join(dir, "out.bin"));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("corrupt entry");
    expect(readFileSync(join(dir, "out.bin"), "utf8")).toBe("tool-bytes-v1");
  });

  it("file:// 은 opt-in 없이는 거부된다 — https 핀 유지", () => {
    const { url, sha } = fixture("tool-bytes-v1");
    const result = run(url, sha, join(dir, "out.bin"), {
      HEBBIAN_CI_TOOL_CACHE_ALLOW_FILE: "",
    });
    expect(result.status).not.toBe(0);
  });

  it("잘못된 sha 인자는 즉시 거부한다", () => {
    const { url } = fixture("x");
    expect(run(url, "abc", join(dir, "out.bin")).status).toBe(2);
    expect(run(url, "Z".repeat(64), join(dir, "out.bin")).status).toBe(2);
  });

  it("30일 지난 엔트리는 기회적으로 정리된다", () => {
    const a = fixture("old-bytes");
    run(a.url, a.sha, join(dir, "out-a.bin"));
    const oldEntry = join(dir, "cache", a.sha);
    const past = (Date.now() - 40 * 86400 * 1000) / 1000;
    utimesSync(oldEntry, past, past);

    writeFileSync(a.source, "new-bytes");
    const b = { url: a.url, sha: createHash("sha256").update("new-bytes").digest("hex") };
    const result = run(b.url, b.sha, join(dir, "out-b.bin"));
    expect(result.status).toBe(0);
    expect(() => statSync(oldEntry)).toThrow();
  });
});
