import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptLossFixture } from "./spawn-prompt-receipt-loss-fixture.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("spawn prompt receipt-loss fixture", () => {
  it("keeps the local project and provider capture as the defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-loss-inputs-"));
    roots.push(root);
    const inputs = path.join(root, "provider-inputs", "session-1");
    fs.mkdirSync(inputs, { recursive: true });
    fs.writeFileSync(path.join(inputs, "000002.input"), "second");
    fs.writeFileSync(path.join(inputs, "000001.input"), "first");
    fs.writeFileSync(path.join(inputs, "ignored"), "ignored");

    const execute = vi.fn();
    const fixture = createReceiptLossFixture({
      captureRoot: root,
      environment: {
        DURE_QA_PROVIDER_INPUTS_LIMA_VM: "stale-vm",
        DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT: "/stale/capture",
      },
      execute,
    });

    expect(fixture.projectReadyEvent).toBe("qa-local-project");
    expect(fixture.providerInputs("session-1")).toEqual(["first", "second"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads SSH inputs through the separately owned Lima control plane", () => {
    const execute = vi.fn(() => '["one prompt"]\n');
    const fixture = createReceiptLossFixture({
      captureRoot: "/unused/local/capture",
      environment: {
        DURE_QA_PROJECT_KIND: "ssh",
        DURE_QA_PROVIDER_INPUTS_LIMA_HOME: "/Users/qa/.lima",
        DURE_QA_PROVIDER_INPUTS_LIMA_VM: "receipt-loss-vm",
        DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT: "/tmp/receipt-loss-capture",
      },
      execute,
    });

    expect(fixture.projectReadyEvent).toBe("qa-ssh-project");
    expect(fixture.providerInputs("session-remote")).toEqual(["one prompt"]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe("limactl");
    const args = execute.mock.calls[0]?.[1];
    expect(args?.slice(0, 5)).toEqual([
      "shell",
      "--tty=false",
      "receipt-loss-vm",
      "python3",
      "-c",
    ]);
    expect(args?.[5]).toContain('pathlib.Path(sys.argv[1]) / "provider-inputs"');
    expect(args?.slice(-2)).toEqual([
      "/tmp/receipt-loss-capture",
      "session-remote",
    ]);
    expect(execute.mock.calls[0]?.[2]?.env?.LIMA_HOME).toBe(
      "/Users/qa/.lima",
    );
  });

  it("rejects unknown project kinds and incomplete remote observers", () => {
    expect(() =>
      createReceiptLossFixture({
        captureRoot: "/tmp/local",
        environment: { DURE_QA_PROJECT_KIND: "remote" },
      }),
    ).toThrow("DURE_QA_PROJECT_KIND is invalid");
    expect(() =>
      createReceiptLossFixture({
        captureRoot: "/tmp/local",
        environment: {
          DURE_QA_PROJECT_KIND: "ssh",
          DURE_QA_PROVIDER_INPUTS_LIMA_VM: "receipt-loss-vm",
        },
      }),
    ).toThrow("DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT");
    expect(() =>
      createReceiptLossFixture({
        captureRoot: "/tmp/local",
        environment: {
          DURE_QA_PROJECT_KIND: "ssh",
          DURE_QA_PROVIDER_INPUTS_LIMA_VM: "receipt-loss-vm",
          DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT: "/tmp/remote",
        },
      }),
    ).toThrow("DURE_QA_PROVIDER_INPUTS_LIMA_HOME");
  });
});
