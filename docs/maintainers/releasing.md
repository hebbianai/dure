# Official macOS beta releases

Official builds use an exact reviewed commit from `hebbianai/dure:main`, not a
different repository or a moving branch. The [Release workflow](../../.github/workflows/release.yml)
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
An organization runner administrator must verify the selected-workflow policy
is available and enforced before registration. Do not substitute an unrestricted
group when that policy is unavailable; choose separately isolated signing
infrastructure first. Environment approval alone does not protect a persistent
host from other workflows. See GitHub's
[runner-group access policy](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

Create the `macos-release` environment with a main-only deployment policy and
maintainer approval. Register these secrets in that environment:

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

Wait for `Public repository checks` on the exact selected commit. Run Release
only on main, supplying its full 40-character SHA as `source_sha` and `patch` or
`minor` as `bump`. GitHub's selected source must equal the requested SHA; later
main changes do not alter an admitted run.

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

This compares the draft's exact four files with the successful workflow
artifact, checks the single-parent version commit, verifies the updater archive
against the exact-tag public key, and checks beta/version/immutable URLs.
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
