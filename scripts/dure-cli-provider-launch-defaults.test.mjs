import { describe, expect, it } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  collectProviderLaunchDefaults,
  providerLaunchDefaultsExitCode,
} from "../cli/lib/provider-launch-defaults.mjs";

const fingerprint = `sha256:${"d".repeat(64)}`;
const current = {
  schemaVersion: 1,
  revision: 4,
  defaults: {
    claude: { permissionMode: "require_approvals" },
  },
  fingerprint,
};

function profile(id, transport) {
  return {
    id,
    transport: { kind: transport },
    expected: {
      capabilities: [
        "provider_launch_defaults.get",
        "provider_launch_defaults.put",
      ],
    },
    deadlineMs: 2_500,
  };
}

function response(result, generation = "generation-1") {
  return {
    backend: { id: "backend-a", generation },
    result,
  };
}

describe("provider launch defaults CLI contract", () => {
  it.each([
    ["local", "local"],
    ["ssh-a", "ssh"],
    ["hosted-a", "hosted"],
  ])("uses the same authority receipt through %s", async (id, transport) => {
    const calls = [];
    const report = await collectProviderLaunchDefaults({
      action: "get",
      backend: { profile: profile(id, transport) },
      requestBackend: async (_profile, request) => {
        calls.push(request);
        return response({ schemaVersion: 1, document: current });
      },
    });

    expect(report).toMatchObject({
      complete: true,
      source: { profileId: id, transport },
      document: current,
    });
    expect(calls).toEqual([
      {
        operation: "provider_launch_defaults.get",
        requiredCapabilities: ["provider_launch_defaults.get"],
        body: { schemaVersion: 1 },
      },
    ]);
    expect(providerLaunchDefaultsExitCode(report)).toBe(0);
  });

  it("updates the whole document with strict CAS and fences one backend generation", async () => {
    const calls = [];
    const updated = {
      schemaVersion: 1,
      revision: 5,
      defaults: {
        claude: { permissionMode: "require_approvals" },
        codex: { permissionMode: "bypass_approvals" },
      },
      fingerprint: `sha256:${"e".repeat(64)}`,
    };
    const report = await collectProviderLaunchDefaults({
      action: "set",
      providerId: "codex",
      permissionMode: "bypass_approvals",
      idempotencyKey: "provider-defaults-cli-1",
      backend: { profile: profile("ssh-a", "ssh") },
      requestBackend: async (_profile, request) => {
        calls.push(request);
        if (request.operation === "provider_launch_defaults.get") {
          return response({ schemaVersion: 1, document: current });
        }
        return response({
          schemaVersion: 1,
          receipt: {
            schemaVersion: 1,
            idempotencyKey: "provider-defaults-cli-1",
            expectedRevision: 4,
            disposition: "updated",
            document: updated,
            updatedAtMs: 10,
          },
        });
      },
    });

    expect(report).toMatchObject({ complete: true, document: updated });
    expect(calls[1]).toEqual({
      operation: "provider_launch_defaults.put",
      requiredCapabilities: ["provider_launch_defaults.put"],
      body: {
        schemaVersion: 1,
        idempotencyKey: "provider-defaults-cli-1",
        expectedRevision: 4,
        defaults: updated.defaults,
      },
    });
  });

  it("rejects an exact write receipt that changes a sibling provider", async () => {
    const report = await collectProviderLaunchDefaults({
      action: "set",
      providerId: "codex",
      permissionMode: "bypass_approvals",
      idempotencyKey: "provider-defaults-cli-binding",
      backend: { profile: profile("hosted-a", "hosted") },
      requestBackend: async (_profile, request) =>
        request.operation === "provider_launch_defaults.get"
          ? response({ schemaVersion: 1, document: current })
          : response({
              schemaVersion: 1,
              receipt: {
                schemaVersion: 1,
                idempotencyKey: "provider-defaults-cli-binding",
                expectedRevision: 4,
                disposition: "updated",
                document: {
                  schemaVersion: 1,
                  revision: 5,
                  defaults: {
                    claude: { permissionMode: "bypass_approvals" },
                    codex: { permissionMode: "bypass_approvals" },
                  },
                  fingerprint: `sha256:${"e".repeat(64)}`,
                },
                updatedAtMs: 10,
              },
            }),
    });

    expect(report).toMatchObject({
      complete: false,
      error: { code: "provider_launch_defaults_payload_invalid" },
    });
  });

  it("reports a typed conflict when a concurrent put-if-absent winner preserves another value", async () => {
    const empty = {
      schemaVersion: 1,
      revision: 0,
      defaults: {},
      fingerprint: `sha256:${"0".repeat(64)}`,
    };
    const winner = {
      schemaVersion: 1,
      revision: 1,
      defaults: { codex: { permissionMode: "require_approvals" } },
      fingerprint,
    };
    const report = await collectProviderLaunchDefaults({
      action: "set",
      providerId: "codex",
      permissionMode: "bypass_approvals",
      idempotencyKey: "provider-defaults-cli-race",
      backend: { profile: profile("local", "local") },
      requestBackend: async (_profile, request) =>
        request.operation === "provider_launch_defaults.get"
          ? response({ schemaVersion: 1, document: empty })
          : response({
              schemaVersion: 1,
              receipt: {
                schemaVersion: 1,
                idempotencyKey: "provider-defaults-cli-race",
                expectedRevision: 0,
                disposition: "preserved_existing",
                document: winner,
                updatedAtMs: 10,
              },
            }),
    });

    expect(report).toMatchObject({
      complete: false,
      error: { code: "provider_launch_defaults_revision_conflict" },
    });
  });

  it("preserves typed backend failures without falling back to another mode", async () => {
    const report = await collectProviderLaunchDefaults({
      action: "get",
      backend: { profile: profile("hosted-a", "hosted") },
      requestBackend: async () => {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { code: "provider_launch_defaults_malformed" },
        });
      },
    });

    expect(report).toMatchObject({
      complete: false,
      error: {
        code: "backend_transport_remote_error",
        remoteCode: "provider_launch_defaults_malformed",
      },
    });
    expect(report).not.toHaveProperty("document");
    expect(providerLaunchDefaultsExitCode(report)).toBe(2);
  });
});
