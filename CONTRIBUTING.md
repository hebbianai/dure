# Contributing to Dure

Dure is maintained by Hebbian AI. We welcome clear bug reports, focused proposals,
documentation improvements and translations. Please follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Source and development

Dure's first-party source is available under [MIT](LICENSE). Third-party
components keep their existing licenses and copyright notices.

The native workflow below targets **Apple Silicon macOS**. Install Git, Xcode
Command Line Tools, the Node version in [.node-version](.node-version), and
[rustup](https://rustup.rs/). Use an official Node macOS binary for app packaging;
the bundled Node executable must depend only on macOS system libraries.
[package.json](package.json) pins pnpm, and
[rust-toolchain.toml](rust-toolchain.toml) pins Rust and its required targets.

Clone your fork, then run these commands from its root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm app:dev
```

Keep the development command running in its own terminal. Each checkout gets a
development app channel. Development channels share ordinary Dure application
data; use disposable data and discovery roots for automated runtime QA.

To package a local app, commit your changes on your topic branch and run:

```sh
pnpm build:app
```

Packaging requires a clean tracked source tree. The command builds the frontend,
Hmux, remote helpers, CLI and native app. It writes
`src-tauri/target/release/bundle/macos/Dure.app` without publisher signing,
notarization or updater artifacts. It does not install or launch the app.
Use [official downloads](https://www.dureai.dev/download/mac/) for the distributed
build. Rebuilding from source does not require signing keys or GitHub credentials;
the pinned native inputs are downloaded from a public release and verified.

The build checks free disk space and concurrent reservations before it starts.
The current local full-build requirement is 110 GiB free, plus other active build
reservations. Follow the actual refusal message and inspect `pnpm disk:status`
instead of bypassing admission. The build budgets are defined in
[disk-space.mjs](scripts/lib/disk-space.mjs).

For frontend-only work, `pnpm build:frontend` builds the web UI. It does not
produce the native desktop app.

## Issues and proposals

Search [existing issues](https://github.com/hebbianai/dure/issues) before opening
a report. Use the [issue forms](https://github.com/hebbianai/dure/issues/new/choose)
to include the app version, environment, reproduction steps, and expected and
actual behavior. For a substantial change, discuss the problem in an issue
before investing in an implementation.

Remove credentials, private conversations, customer data and identifying file
paths from screenshots and logs. Report suspected vulnerabilities through the
private channel in [SECURITY.md](SECURITY.md).

## Your first pull request

1. Fork this repository and clone your fork.
2. Create a topic branch from the current `main`, for example
   `git switch -c docs/clarify-installation`.
3. Make one focused change. Preserve existing copyright and third-party notices.
4. Run the relevant checks below, preview changed documentation and run
   `git diff --check`. Describe the checks you actually performed and their limits.
5. Push your branch to your fork and open a pull request against
   `hebbianai/dure:main`. Explain the problem, the change, and how you checked it;
   link a related issue when one exists.
6. Address review feedback and wait for the required checks and maintainer review.

English is the canonical documentation language. The English [README](README.md)
lives at the root; the six translations live in [docs/readme/](docs/readme/).
Keep facts consistent across all seven languages when changing shared product
information. If you cannot update a translation confidently, call that out in the
pull request so a maintainer can coordinate it. Translation corrections for one
language are also welcome. Do not claim availability for unreleased source,
platforms or features.

## Branches and releases

Dure follows [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow):
create a short-lived topic branch from `main`, submit a pull request against
`main`, and address review feedback before merging. Use a descriptive branch name
such as `docs/build-guide`, `fix/terminal-resize` or `feat/session-search` for the
files available in the repository. These prefixes are naming suggestions.

Keep each pull request focused on one change. Open a draft pull request when you
want feedback before the work is ready. Multiple commits during review are fine;
maintainers squash the approved change when merging. After merging, start the
next change from the updated `main`. Merged branches in this repository are
deleted automatically; remove the completed topic branch from your fork too.

Maintainers manage version bumps, release branches, tags and publication. Include
release changes in an ordinary contribution only when a maintainer requests them.

## Checks and review

The public workflow runs the same source checks available locally:

```sh
pnpm verify:frontend
pnpm test:scripts
```

`verify:frontend` checks the dependency installation, types, lint, dependency
graph and unused code, runs frontend tests and builds the web UI. `test:scripts`
runs the script and CLI fixture suites with the repository's existing project
boundaries. Neither command proves a native app or live provider workflow works.
For Rust, terminal or process-lifecycle changes, also include the relevant crate
checks and native smoke evidence. Runtime QA must use disposable HOME, DURE_HOME
and a unique HMUX_DISCOVERY_ROOT through the existing QA runners. A separate
app channel alone does not isolate runtime data.

Behavior changes need tests that exercise the actual behavior. For a visible UI
change, include before/after images or a short video and describe the interaction
checks. Cosmetic text or styling changes do not need a new regression test.

CI also checks whitespace and local documentation links. To run the link check with
[lychee](https://github.com/lycheeverse/lychee), use:

```sh
lychee --offline --include-fragments --no-progress '*.md' 'docs/readme/*.md' '.github/**/*.md'
```

The workflow pins its action versions in
[public-repository.yml](.github/workflows/public-repository.yml). The required
`Public repository checks` result succeeds only when documentation, frontend and
script checks all succeed. Full native builds, signing and releases are separate
maintainer verification steps.

Contributors submit changes to `main` through pull requests. Merging requires
passing checks, an up-to-date branch, one approving review, code-owner approval
where applicable, and resolved review conversations. New changes dismiss stale
approvals; the latest push needs approval from someone other than its pusher.
Maintainers squash approved pull requests; the ruleset blocks force pushes and
deletion of `main`. See the [active repository rules](https://github.com/hebbianai/dure/rules)
for the enforced settings.

The repository administrator `komojini` has an explicit always-on bypass for this
ruleset, including direct pushes and merges without the required review or checks.
Other contributors and administrators remain subject to the rules above.

Contributors remain responsible for everything they submit, including work
prepared with AI tools. Check the diff, verify claims, and describe any testing
limits. Maintainers may request a smaller scope or further evidence before
accepting a change.

## Licensing

Submit only work you have the right to contribute under the project's
[MIT license](LICENSE). Preserve third-party licenses and identify the source and
license of any material you add.
