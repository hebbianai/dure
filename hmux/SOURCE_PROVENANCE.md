# Hmux Source Provenance

`hebbianai/HebbianIDE` is the canonical writable source for Hmux. Future Hmux
feature changes start under this repository's `hmux/` directory.

## Imported Baseline

- Source repository: `git@github.com:hebbianai/hebbian-agents.git`
- Source commit: `af2a04a39429516b7f4f68cbec4134062d4b2aaf`
- Source `hmux` tree: `d1007c3346bd48a00cdc10c9de2d0b461761b883`
- Imported tracked files: 46
- Import commit: `f5540edf04d67fdea032f75c5ef9194b67d4debe`
- Import date: 2026-07-26

The import commit contains the source subtree without modification. Its
`hmux` tree object exactly matches the source tree object above. The following
commits change repository ownership documentation, links, licensing, local
build-output ignores, target-local verification entry points, and one focused
retirement-fence repair exposed by the imported test suite. The repair keeps
exact archived-generation lookup while refusing a stale retry when another
archived generation exists. No HebbianIDE runtime integration is added or
enabled.

The source repository's root MIT license at the same commit is carried as
[`LICENSE`](./LICENSE). It was not part of the 46-file source subtree and is
therefore an intentional target-only addition.

## Audit

Fetch the pinned source commit into a HebbianIDE checkout, then compare the
source tree with the pure import commit:

```sh
git fetch --no-tags git@github.com:hebbianai/hebbian-agents.git \
  af2a04a39429516b7f4f68cbec4134062d4b2aaf
test "$(git rev-parse FETCH_HEAD:hmux)" = \
  d1007c3346bd48a00cdc10c9de2d0b461761b883
test "$(git rev-parse f5540edf04d67fdea032f75c5ef9194b67d4debe:hmux)" = \
  d1007c3346bd48a00cdc10c9de2d0b461761b883
git diff --exit-code FETCH_HEAD:hmux \
  f5540edf04d67fdea032f75c5ef9194b67d4debe:hmux
```

## Temporary Consumer Mirror

`hebbian-agents/hmux` remains a temporary downstream consumer mirror because
`hebbian-agent` still has a relative path dependency on `hmux-host`. It is not a
second writable source. A separate reviewed change must replace or synchronize
that mirror from an exact HebbianIDE commit before the source relation can be
closed. This target-repository checkpoint does not edit the old checkout or
enable HebbianIDE runtime integration.

## Public TUF verifier fixtures

`hmux/crates/hmux-release-trust/tests/fixtures` contains generated public signed
metadata and harmless target archives. It contains no copied upstream source
and no private key material. The generator uses:

- `theupdateframework/python-tuf` v7.0.0, commit
  `353bdb767db56fd4667c9bcf56b710d50fdc2ac0`, wheel SHA-256
  `572bdbdc9ff4a82278a0d4773e6100863b9b33023f27575e84ca65b486dd0d79`,
  Apache-2.0 OR MIT;
- `secure-systems-lab/securesystemslib` v1.3.1, commit
  `6f774190b90f0aa9d5d7e077680adbaa29c5cd6c`, wheel SHA-256
  `2e5414bbdde33155a91805b295cbedc4ae3f12b48dccc63e1089093537f43c81`,
  MIT.

The disposable signing keys exist only in generator process memory.
`tests/fixtures/MANIFEST.sha256` authenticates the committed public output
within the reviewed source tree. Regeneration intentionally creates a new
public test authority and therefore requires a normal review of the complete
fixture diff.

The official TUF conformance source is not copied into this repository. CI
checks out exact upstream commit
`51ee32b3a7cee80d4f998b164357d7c78fe7c541`, records the resolved Python
environment and adapter/Cargo lock digests, and runs the focused test selection
declared in `.github/workflows/hmux-release-trust.yml`. The complete
`libfaketime` suite remains pending the native Linux gate; this provenance
record does not claim full upstream conformance.

On 2026-07-30 the native Linux gate was added without copying the upstream
source into this repository. It checks out the same exact commit above, builds
the adapter from the exact repository commit with Rust 1.85.0 standalone
archive SHA-256
`024918027c349bd237617a8a1207d7c4462f70549a31e8bf6c14b0601cfd489e`,
and runs the complete 112-test suite with `libfaketime` in Ubuntu image digest
`2eaec7286c49fdea713dddabcf5012cafa7097a658e916acb48f4bc5fdc8e419`
and package snapshot `20260725T000000Z`. The strict exclusion file names 29
exact collected testcases; CI rejects stale declarations and any difference
between declared and actual expected failures. The initial native execution
produced 83 passes and 29 strict expected failures.
