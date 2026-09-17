import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { buildBackendSshArgv } from "../cli/lib/backend-transport.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

it.each(["ssh_agent", "identity_file"])(
  "limits effective OpenSSH trust and %s authentication to the selected authority",
  (kind) => {
    const profile = sshBackendProfile({
      auth:
        kind === "identity_file" ? identityFileAuth("remote-build") : { kind },
    });
    const material = {
      knownHostsFile: "/tmp/dure-fixture-known-hosts",
      ...(kind === "identity_file"
        ? { identityFile: "/tmp/dure-fixture-identity" }
        : {}),
    };
    const argv = buildBackendSshArgv(profile, material);
    // -G prints effective configuration and exits without opening a connection.
    const result = spawnSync(argv[0], ["-G", ...argv.slice(1)], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const values = (key) =>
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith(`${key} `))
        .map((line) => line.slice(key.length + 1));
    expect(values("globalknownhostsfile")).toEqual(["/dev/null"]);
    expect(values("userknownhostsfile")).toEqual([material.knownHostsFile]);
    expect(values("identityfile")).toEqual([material.identityFile ?? "none"]);
    expect(values("preferredauthentications")).toEqual(["publickey"]);
    expect(values("hostbasedauthentication")).toEqual(["no"]);
    expect(values("gssapiauthentication")).toEqual(["no"]);
  },
);
