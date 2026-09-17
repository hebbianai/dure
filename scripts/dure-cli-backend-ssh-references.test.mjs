import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_SSH_REFERENCES_FILE,
  MAX_BACKEND_SSH_REFERENCES_BYTES,
  resolveBackendSshReferencesFromEnvironment,
} from "../cli/lib/backend-ssh-references.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

const roots = [];
const fixturePath = fileURLToPath(
  new URL(
    "../src-tauri/tests/fixtures/dure-backend-ssh-reference-catalog.json",
    import.meta.url,
  ),
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-ssh-reference-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function material(root, name, contents = `${name}\n`) {
  const path = join(root, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function fixture(root) {
  const paths = {
    __IDENTITY_A__: material(root, "identity-a", "private-a\n"),
    __IDENTITY_B__: material(root, "identity-b", "private-b\n"),
    __KNOWN_HOSTS_A__: material(root, "known-hosts-a", "host-a key-a\n"),
    __KNOWN_HOSTS_B__: material(root, "known-hosts-b", "host-b key-b\n"),
  };
  const catalog = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const entry of catalog.references) entry.path = paths[entry.path];
  const catalogPath = join(root, BACKEND_SSH_REFERENCES_FILE);
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  chmodSync(catalogPath, 0o600);
  return { catalog, catalogPath, paths };
}

function references(profileId) {
  return {
    auth: {
      kind: "identity_file",
      reference: `credential-profile:${profileId}`,
    },
    profileId,
    trust: {
      kind: "known_hosts",
      reference: `known-hosts-profile:${profileId}`,
    },
  };
}

function expectUnavailable(operation) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BackendTransportError);
    expect(error.code).toBe("backend_transport_reference_unavailable");
    expect(error.message).not.toMatch(/(?:identity|known-hosts)-[ab]/);
    return;
  }
  throw new Error("expected backend_transport_reference_unavailable");
}

function expectMaterial(selection, expected) {
  expect(JSON.stringify(selection)).toBe("{}");
  const pinned = selection.pin();
  try {
    for (const [name, original] of Object.entries(expected)) {
      expect(pinned[name]).not.toBe(original);
      expect(readFileSync(pinned[name])).toEqual(readFileSync(original));
    }
  } finally {
    pinned.dispose();
  }
}

describe("Dure backend SSH reference catalog", () => {
  it("isolates two profiles through the shared strict catalog corpus", () => {
    const root = createRoot();
    const { paths } = fixture(root);
    const environment = { DURE_HOME: root };

    expectMaterial(
      resolveBackendSshReferencesFromEnvironment(
        references("remote-a"),
        environment,
      ),
      {
        identityFile: paths.__IDENTITY_A__,
        knownHostsFile: paths.__KNOWN_HOSTS_A__,
      },
    );
    expectMaterial(
      resolveBackendSshReferencesFromEnvironment(
        references("remote-b"),
        environment,
      ),
      {
        identityFile: paths.__IDENTITY_B__,
        knownHostsFile: paths.__KNOWN_HOSTS_B__,
      },
    );

    const composed = references("remote-b");
    composed.trust.reference = "known-hosts-profile:remote-a";
    expectMaterial(
      resolveBackendSshReferencesFromEnvironment(composed, environment),
      {
        identityFile: paths.__IDENTITY_B__,
        knownHostsFile: paths.__KNOWN_HOSTS_A__,
      },
    );
  });

  const failures = JSON.parse(
    readFileSync(
      new URL(
        "../src-tauri/tests/fixtures/dure-backend-ssh-reference-failures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  it.each(failures.catalogCases)(
    "rejects $name before transport connection",
    ({ catalog: source }) => {
      const root = createRoot();
      const { catalogPath, paths } = fixture(root);
      const catalog = structuredClone(source);
      for (const entry of catalog.references) {
        entry.path = paths[entry.path] ?? entry.path;
      }
      writeFileSync(catalogPath, JSON.stringify(catalog));
      expectUnavailable(() =>
        resolveBackendSshReferencesFromEnvironment(references("remote-a"), {
          DURE_HOME: root,
        }),
      );
    },
  );

  it.each(failures.fileCases)(
    "rejects $target with $fault",
    ({ target, fault }) => {
      const root = createRoot();
      const { catalogPath, paths } = fixture(root);
      const path = {
        catalog: catalogPath,
        knownHosts: paths.__KNOWN_HOSTS_A__,
        identity: paths.__IDENTITY_A__,
      }[target];
      if (fault === "mode") chmodSync(path, 0o644);
      else if (fault === "oversize") {
        const maximum = target === "catalog"
          ? MAX_BACKEND_SSH_REFERENCES_BYTES
          : 1024 * 1024;
        writeFileSync(path, "x".repeat(maximum + 1));
      } else if (fault === "empty") writeFileSync(path, "");
      else if (fault === "symlink") {
        const replacement = material(root, "replacement", readFileSync(path));
        rmSync(path);
        symlinkSync(replacement, path);
      } else throw new Error(`unknown fault: ${fault}`);
      expectUnavailable(() =>
        resolveBackendSshReferencesFromEnvironment(references("remote-a"), {
          DURE_HOME: root,
        }),
      );
    },
  );

  it("allows legacy file variables only for one explicitly fenced profile", () => {
    const root = createRoot();
    const knownHostsFile = material(root, "known-hosts-legacy");
    const identityFile = material(root, "identity-legacy");
    const environment = {
      DURE_BACKEND_IDENTITY_FILE: identityFile,
      DURE_BACKEND_KNOWN_HOSTS_FILE: knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-a",
      DURE_HOME: root,
    };
    expectMaterial(
      resolveBackendSshReferencesFromEnvironment(
        references("remote-a"),
        environment,
      ),
      { identityFile, knownHostsFile },
    );
    expectUnavailable(() =>
      resolveBackendSshReferencesFromEnvironment(
        references("remote-b"),
        environment,
      ),
    );
  });
});
