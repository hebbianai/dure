import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveBackendSshReferencesFromEnvironment } from "../cli/lib/backend-ssh-references.mjs";
import {
  exchangeSshBackendRequest,
  performBackendProfileRequest,
} from "../cli/lib/backend-transport.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture({ mode = "success" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-ssh-pinning-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const profile = sshBackendProfile({
    id: "remote-a",
    auth: identityFileAuth("remote-a"),
    capabilities: ["sessions.list"],
  });
  const paths = {
    knownHostsFile: join(root, "known-hosts"),
    identityFile: join(root, "identity"),
  };
  for (const [name, path] of Object.entries(paths)) {
    writeFileSync(path, `fixture-only-${name}`, { mode: 0o600 });
  }
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references: [
        {
          reference: profile.trust.reference,
          kind: "known_hosts_file",
          path: paths.knownHostsFile,
        },
        {
          reference: profile.auth.reference,
          kind: "identity_file",
          path: paths.identityFile,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const observed = join(root, "observed.json");
  const ssh = join(root, "ssh.cjs");
  writeFileSync(
    ssh,
    `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const options = { knownHostsFile: "UserKnownHostsFile=", identityFile: "IdentityFile=" };
const material = Object.fromEntries(Object.entries(options).map(([name, prefix]) => {
  const path = process.argv.find(value => value.startsWith(prefix)).slice(prefix.length);
  return [name, { path, matched: readFileSync(path, "utf8") === "fixture-only-" + name }];
}));
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(material));
const mode = ${JSON.stringify(mode)};
if (mode === "nonzero") process.exit(41);
if (mode === "output_limit") process.stdout.write("x".repeat(300 * 1024));
if (mode === "wait") {
  process.stdout.write("ready\\n");
  setInterval(() => {}, 1000);
}
const request = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: 1, apiVersion: "dure.backend-transport/v1", kind: "dure.backend.response",
  requestId: request.requestId,
  backend: { id: "remote-backend", generation: "remote-generation-1", protocol: { major: 1, minor: 0 }, capabilities: ["sessions.list"], observedAtMs: Date.now() },
  result: { matched: Object.values(material).every(value => value.matched) },
}));
`,
    { mode: 0o700 },
  );
  return { root, profile, paths, observed, ssh };
}

function request(setup, resolve, options = {}) {
  return performBackendProfileRequest(
    setup.profile,
    {
      body: {},
      operation: "sessions.list",
      requiredCapabilities: ["sessions.list"],
    },
    { sshCommand: setup.ssh, resolveSshReferences: resolve, ...options },
  );
}

it.each(["knownHostsFile", "identityFile"])(
  "rejects replaced selected %s before starting the SSH child",
  async (target) => {
    const setup = fixture();
    await expect(
      request(setup, (input) => {
        const selected = resolveBackendSshReferencesFromEnvironment(input, {
          DURE_HOME: setup.root,
        });
        const replacement = join(setup.root, "replacement");
        writeFileSync(replacement, "replacement-fixture-only", { mode: 0o600 });
        renameSync(replacement, setup.paths[target]);
        return selected;
      }),
    ).rejects.toMatchObject({
      code: "backend_transport_reference_unavailable",
    });
    expect(existsSync(setup.observed)).toBe(false);
  },
);

it("keeps selected bytes available to the SSH child and removes snapshots after exit", async () => {
  const setup = fixture();
  const response = await request(setup, (input) =>
    resolveBackendSshReferencesFromEnvironment(input, {
      DURE_HOME: setup.root,
    }),
  );
  expect(response.result.matched).toBe(true);
  const observed = JSON.parse(readFileSync(setup.observed, "utf8"));
  for (const [name, value] of Object.entries(observed)) {
    expect(value.path).not.toBe(setup.paths[name]);
    expect(value.matched).toBe(true);
    expect(existsSync(value.path)).toBe(false);
    expect(existsSync(setup.paths[name])).toBe(true);
  }
});

it.each([
  ["nonzero", "backend_transport_ssh_failed"],
  ["output_limit", "backend_transport_output_limit"],
  ["wait", "backend_transport_aborted"],
])(
  "removes snapshots after the real SSH child ends with %s",
  async (mode, code) => {
    const setup = fixture({ mode });
    const abort = new AbortController();
    let child;
    let observedWhileRunning = false;
    await expect(
      request(
        setup,
        (input) =>
          resolveBackendSshReferencesFromEnvironment(input, {
            DURE_HOME: setup.root,
          }),
        {
          signal: abort.signal,
          sshExchange: (argv, input, options) =>
            exchangeSshBackendRequest(argv, input, {
              ...options,
              spawnProcess: (...args) => {
                child = spawn(...args);
                child.stdout.once("data", () => {
                  const material = JSON.parse(
                    readFileSync(setup.observed, "utf8"),
                  );
                  observedWhileRunning = Object.values(material).every(
                    (value) => existsSync(value.path),
                  );
                  if (mode === "wait") abort.abort();
                });
                return child;
              },
            }),
        },
      ),
    ).rejects.toMatchObject({ code });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (mode !== "nonzero") expect(observedWhileRunning).toBe(true);
    const material = JSON.parse(readFileSync(setup.observed, "utf8"));
    expect(
      Object.values(material).every((value) => !existsSync(value.path)),
    ).toBe(true);
  },
  20_000,
);

it("disposes material when the SSH executable cannot spawn", async () => {
  const setup = fixture();
  let pinned;
  await expect(
    request(
      setup,
      (input) => {
        const selected = resolveBackendSshReferencesFromEnvironment(input, {
          DURE_HOME: setup.root,
        });
        return {
          pin: () => {
            pinned = selected.pin();
            return pinned;
          },
        };
      },
      { sshCommand: join(setup.root, "missing-command") },
    ),
  ).rejects.toMatchObject({
    code: "backend_transport_ssh_unavailable",
  });
  expect(existsSync(pinned.knownHostsFile)).toBe(false);
  expect(existsSync(pinned.identityFile)).toBe(false);
});

it("keeps each lease independent and immune to later source replacement", () => {
  const setup = fixture();
  const selected = resolveBackendSshReferencesFromEnvironment(
    {
      auth: setup.profile.auth,
      trust: setup.profile.trust,
      profileId: setup.profile.id,
    },
    { DURE_HOME: setup.root },
  );
  const first = selected.pin();
  const second = selected.pin();
  try {
    for (const path of Object.values(setup.paths))
      writeFileSync(path, "replaced");
    expect(first.knownHostsFile).not.toBe(second.knownHostsFile);
    for (const [name, original] of Object.entries(setup.paths)) {
      expect(readFileSync(first[name], "utf8")).toBe(`fixture-only-${name}`);
      expect(readFileSync(second[name], "utf8")).toBe(`fixture-only-${name}`);
      expect(readFileSync(original, "utf8")).toBe("replaced");
    }
    first.dispose();
    first.dispose();
    expect(existsSync(second.identityFile)).toBe(true);
    expect(() => selected.pin()).toThrow(
      expect.objectContaining({
        code: "backend_transport_reference_unavailable",
      }),
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("the real SSH child reads pinned bytes after both original paths are replaced", async () => {
  const setup = fixture();
  const result = await request(
    setup,
    (input) =>
      resolveBackendSshReferencesFromEnvironment(input, {
        DURE_HOME: setup.root,
      }),
    {
      sshExchange: (argv, input, options) => {
        for (const path of Object.values(setup.paths))
          writeFileSync(path, "replaced");
        return exchangeSshBackendRequest(argv, input, options);
      },
    },
  );
  expect(result.result.matched).toBe(true);
  const material = JSON.parse(readFileSync(setup.observed, "utf8"));
  expect(
    Object.values(material).every((value) => !existsSync(value.path)),
  ).toBe(true);
});
