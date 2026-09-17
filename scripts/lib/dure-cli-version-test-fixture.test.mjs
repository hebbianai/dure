import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dureCliVersionExpectation } from "./dure-cli-version-test-fixture.mjs";

const temporaryDirectories = [];

function fixture(manifest) {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "dure-cli-version-fixture-"),
  );
  temporaryDirectories.push(repository);
  fs.mkdirSync(path.join(repository, "cli"));
  fs.writeFileSync(
    path.join(repository, "cli", "package.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return repository;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dure CLI version test fixture", () => {
  it("derives literal output patterns from a bumped fixture manifest", () => {
    const expectation = dureCliVersionExpectation(
      fixture({ name: "dure-cli", version: "1.2.3+fixture.regex" }),
    );

    expect(expectation.packageVersion).toBe("1.2.3+fixture.regex");
    expect("dure 1.2.3+fixture.regex (source)\n").toMatch(
      expectation.sourceOutput,
    );
    expect("dure 1.2.3+fixture.regex ").toMatch(expectation.installedPrefix);
    expect(
      "dure 1.2.3+fixture.regex (1.2.3+fixture.regex+abc.DEF-1_2)\n",
    ).toMatch(expectation.installedOutput);
    expect("dure 1x2x3+fixtureXregex (source)\n").not.toMatch(
      expectation.sourceOutput,
    );
  });

  it.each([
    { name: "other-cli", version: "1.2.3" },
    { name: "dure-cli", version: "not a version" },
  ])("rejects an invalid fixture manifest %#", (manifest) => {
    expect(() => dureCliVersionExpectation(fixture(manifest))).toThrow(
      /Dure CLI fixture manifest is invalid/u,
    );
  });
});
