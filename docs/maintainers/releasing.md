# Official macOS beta releases

Official builds default to the dispatch's exact `hebbianai/dure:main` commit.
A repository administrator may instead select a reviewed branch, tag or full
commit SHA in this repository. The [Release workflow](../../.github/workflows/release.yml)
creates a version-only commit, signed build and four-asset **draft** in
`hebbianai/dure`. It does not publish, install or restart a user's app.

## Provision once

Use a dedicated macOS ARM64 signing host with a logged-in Finder session.
Do not register a maintainer's daily-driver host for public pull requests.
Provision an organization runner group named `dure-release`, restricted to this
repository and `hebbianai/dure/.github/workflows/release.yml@refs/heads/main`;
its runners need the
`dure-release`, `macOS` and `ARM64` labels. Public PR/source checks stay on
GitHub-hosted runners and receive no publisher credentials.
The workflow must first exist on `main`: GitHub rejects a selected-workflow
runner-group rule for a workflow that is only present on a topic branch.
An organization runner administrator must verify the selected-workflow policy
is available and enforced before registration. Do not substitute an unrestricted
group when that policy is unavailable; choose separately isolated signing
infrastructure first. Environment approval alone does not protect a persistent
host from other workflows. See GitHub's
[runner-group access policy](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

Create the `macos-release` environment with a main-only deployment policy,
`komojini` as its required reviewer, and administrator bypass disabled.
Register these secrets in that environment:

- `APPLE_SIGNING_IDENTITY`: the existing valid Developer ID Application identity.
- One notarization route: `APPLE_ID`, app-specific `APPLE_PASSWORD` and
  `APPLE_TEAM_ID`; or `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.
  The API private-key file must already be privately provisioned on the runner.
- `TAURI_SIGNING_PRIVATE_KEY` and, when required, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Preserve the existing updater key: installed clients trust its shipped public
  key. Do not rotate it as a repository migration shortcut.

Provision the certificate and its private key in the runner's signing keychain
through its owner. Do not add `APPLE_CERTIFICATE` or automatic P12-import steps:
the existing readiness check deliberately refuses shared-keychain mutation.
Keep credentials out of issues, shell arguments, logs and Git. Existing GitHub
secret values cannot be read back for copying; use the original secure source or
a narrowly scoped organization secret policy.

Set environment variable `DURE_TELEMETRY_KEY` to the existing public telemetry
project token. The build refuses an empty value and checks the compiled binary.
Normal storage admission and isolated Cargo/process ownership are unchanged.
The hosted version job uses its scoped `GITHUB_TOKEN` to create only the release
branch/tag and request exact-tag CI; it does not need a private-repository deploy
key or a main-branch protection bypass.

## Select the source and version

Reconcile development's nine version inventory files with all previously
reserved desktop versions before dispatch. This transition reserves versions
through `0.2.28`; the first new public-source release must be `0.2.29` or later.
The initial public snapshot still says `0.2.26`, so that bookkeeping needs a
separately reviewed update before the first run. Never copy historical product
files over current main or rewrite existing tags/assets.

Run Release only on `main`, with `patch` or `minor` as `bump`. Leave `source_ref`
empty or set it to `main` to use GitHub's dispatch commit, without manually
copying a SHA. Alternatively supply a same-repository branch, tag or full
40-character commit SHA. Qualified `refs/heads/...` and `refs/tags/...` remove
name ambiguity. Fork URLs, pull-request refs and revision expressions are not
release sources. The dispatch actor and rerun actor must have repository admin
permission; approval of the protected signing environment remains separate.

The hosted source job resolves the input once and records the immutable source
SHA, protected workflow SHA, requested ref, version and verification profile in
`release-selection`. Its summary shows both SHAs before protected jobs start.
`Public repository checks` must be green for both exact commits. Later branch
movement never changes candidate preparation, verification or the tag parent.
The privileged version writer and draft publisher execute helpers from the
protected workflow commit, not from the chosen application branch. The signed
app is built from the version-only tag commit. Source selection is a trusted
administrator operation: approving arbitrary unreviewed code for a signing
host is unsafe, even when the workflow definition is protected.

For example, after the workflow is on main:

```sh
gh workflow run release.yml --repo hebbianai/dure --ref main \
  -f source_ref=main -f bump=patch -f verification=full
```

`verification=full` is the default and requires remote `pnpm verify:release`.
An explicitly authorized `emergency-0.2` selection is confined to beta versions
`0.2.x`; its public notes disclose that full regression is deferred. It does not
waive source CI, normal admission, Apple signing/notarization, updater signature,
artifact integrity, packaged acceptance or cleanup, and cannot admit `0.3.x`.
Each emergency run needs fresh maintainer authorization for its selected version;
the option does not reuse a historical exception for a later release.

The independent hosted version writer treats the candidate patch as data. It
reconstructs every allowed manifest/lock byte from the frozen source, commits
only that version inventory, and atomically publishes `release/vX.Y.Z` and
`vX.Y.Z`. Source `main` is not changed by a release.

## Accept and publish

After the Release workflow and exact-tag Public repository CI succeed:

```sh
node scripts/release-public.mjs verify v0.2.29
```

Run these operator commands from the reviewed release-tool checkout, not an
arbitrary application branch. They match the successful run's protected workflow
SHA and frozen selection artifact to the draft provenance, then compare the
draft's exact four files with the successful workflow artifact, check the
single-parent version commit, verify the updater archive
against the exact-tag public key, and check beta/version/immutable URLs.
It is integrity evidence, **not native acceptance**.

Before publishing, inspect the unchanged signed DMG and mode-preserved archive;
compare full file/type/mode/symlink manifests. Observe Finder first-open/reopen,
fresh stable-channel packaged CLI bootstrap and a healthy same-terminal pair of
commands in an empty disposable home. Use unique discovery/install/runtime
roots, the existing run-observed ownership supervisor and exact exit proof.
Protect installed/development apps, their data, existing mounts and other work.
Retain the source/run/file hashes and actual UI/process/cleanup receipts.

After that explicit operator acceptance, with a GitHub CLI identity authorized
to publish `hebbianai/dure` and update the compatibility feed:

```sh
node scripts/release-public.mjs publish v0.2.29
```

The command publishes a prerelease/nonlatest release, downloads all four files
anonymously, rechecks hashes/signature, then conditionally updates the existing
`hebbianai/hebbian-releases:main/beta/latest.json`. Its URL stays unchanged for
installed clients; the new manifest points to the immutable archive in `dure`.
An optional `DURE_BETA_FEED_TOKEN` is used only for that compatibility repository;
the new repository's `GITHUB_TOKEN` alone cannot write a different repository.

Finish with an actual homepage `/download/mac/` browser download and a clean
quarantined launch in another isolated home, followed by owned cleanup and
protected-baseline comparison. Website routing is a separate integration:
confirm its resolver accepts the new canonical `dure` release URLs before the
first cutover; do not claim the website changed because the manifest changed.

## Resume without replacing assets

Draft staging uploads only absent names. Existing names must already match the
original size/digest; a partial upload or mismatch stops the operation. A lost
response is reobserved before another write. Never delete or overwrite a
versioned asset to make a retry pass. A failed draft-upload job can be rerun on
the same workflow artifact; do not rebuild or dispatch another version to mask
an upload failure.
Use **Re-run failed jobs**, not **Re-run all jobs**: the source job deliberately
refuses a second selection within the same run. If source admission itself
failed before producing any candidate/version, start a new dispatch only after
reconciling that the intended version is still unused.

If the frozen publisher itself is defective, rerunning that job repeats its
defect. After merging and checking the repair, a repository administrator may
resume the existing draft from a clean checkout of reviewed tooling on `main`:

```sh
node scripts/release-public.mjs recover-draft v0.2.29
node scripts/release-public.mjs verify v0.2.29
```

Recovery requires exact tooling CI, the original successful source, candidate,
version and signed build jobs, the declared verification result, and a failed
draft job. It checks the original selection and build artifacts, uploads only
missing matching assets, downloads them for comparison, and records the operator,
tooling commit, original run, release identity and asset hashes in the draft.
It does not publish or update the compatibility feed. The original workflow
remains failed and the notes disclose recovery; subsequent verification and
publication accept this recorded case while retaining every artifact and CI
check. Packaged native acceptance remains required before publication.

If publication succeeded but metadata writing or anonymous cache readback is
uncertain, resume only:

```sh
node scripts/release-public.mjs metadata-only v0.2.29
```

This rechecks the same source/run/public files without changing release assets.
The compatibility writer uses the previous Git blob SHA, rejects downgrades and
same-version divergence, and requires exact anonymous raw-byte readback. A
response/cache failure remains a failure until those bytes can be observed.
Retain failed receipts and evidence directories; successful integrity checks do
not resolve unrelated historical runtime or verification incidents.
