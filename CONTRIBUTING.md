# Contributing to Dure

Dure is maintained by Hebbian AI. We welcome clear bug reports, focused proposals,
documentation improvements and translations. Please follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Source and development

Dure's first-party source, including Hmux, is available under
[GNU GPL version 3 only (GPL-3.0-only)](LICENSE). Third-party components keep
their existing licenses and copyright notices.

## Development installation

Start with Git, the exact Node version in [.node-version](.node-version), and
[rustup](https://rustup.rs/). Use the host prerequisites in the
[platform sections below](#platforms) before launching a native app.
[package.json](package.json) pins pnpm; Corepack selects that version.
[rust-toolchain.toml](rust-toolchain.toml) pins Rust, components and targets.
An initial setup needs network access to download packages and native build inputs.

Clone the public repository, or substitute your fork's URL if you plan to open a
pull request. Run the remaining commands from the repository root:

```sh
git clone https://github.com/hebbianai/dure.git
cd dure
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
rustup show active-toolchain
```

If `corepack` is unavailable, install it with `npm install --global corepack`,
then retry `corepack enable`; see the
[Corepack installation guide](https://github.com/nodejs/corepack#how-to-install).
Check `node --version` against `.node-version` and `pnpm --version` against
`packageManager` in `package.json`. Run Rust commands inside this checkout so
rustup uses its pinned toolchain.

On an Apple Silicon Mac, continue with [running the development app](#run-the-development-app).
For a standalone `.app`, follow [building and installing a local app](#build-and-install-a-local-app).
Windows/Linux and mobile setup are described in their platform sections.

## Platforms

The desktop source in [src/](src/) and [src-tauri/](src-tauri/) covers macOS,
Windows and Linux. The [mobile/](mobile/) project contains the iOS and Android
client. Shared runtime and protocol changes can affect several platforms.

| Platform | Development entrypoints | Current verification and distribution |
| --- | --- | --- |
| macOS, Apple Silicon | `pnpm app:dev`, `pnpm build:app` | Anonymous source app build and isolated background native smoke verified. Official desktop download available. |
| Windows, x86_64 MSVC | `pnpm app:windows:doctor`, `pnpm app:windows:verify`, `pnpm app:windows:build` | Desktop source and NSIS packaging configuration included. Native desktop acceptance and a public installer remain separate from shared-code CI. |
| Linux, x86_64 | `pnpm app:linux:doctor`, `pnpm app:linux:verify`, `pnpm app:linux:build` | Desktop source and Debian/AppImage packaging configuration included. Linux script/frontend CI does not establish desktop runtime acceptance. |
| iOS | `pnpm --dir mobile tauri ios dev` | Mobile source and Xcode project included. Web tests and shared protocol checks run in CI; device builds, signing and distribution require their own verification. |
| Android | `pnpm --dir mobile android:dev` | Mobile source and Gradle project included. Web tests and shared protocol checks run in CI; emulator/device builds and distribution require their own verification. |

### macOS desktop

The current automatic native bootstrap and `build:app` support Apple Silicon.
Install Xcode Command Line Tools and finish its installer before continuing:

```sh
xcode-select --install
```

Use the [official Node macOS binary](https://nodejs.org/download/release/)
matching `.node-version` for app packaging; the bundled executable must depend
only on macOS system libraries. Complete the [shared setup](#development-installation).
Install and sign in to a supported coding-agent CLI to use agents in the app;
provider accounts and subscriptions are your own.

#### Run the development app

From the repository root:

```sh
pnpm app:dev
```

The launcher prepares the development Hmux runtime and Dure CLI, starts the
frontend and native app, and prints its log path after readiness. The first
launch compiles native components and can take longer than later launches.
There is no separate global Hmux or Dure CLI installation step for this workflow.
Use the full launcher for desktop development; `pnpm dev` starts the frontend
preparation/server and does not launch the native app by itself.

Each checkout gets a development app channel. The supervisor continues running
independently of the launching terminal, so closing that terminal does not stop
it. Development channels share ordinary Dure application data; use disposable
data and discovery roots for automated runtime QA.

#### Build and install a local app

Commit your changes on your topic branch, check that the tracked tree is clean
with `git status --short`, then run:

```sh
pnpm build:app
```

Packaging requires a clean tracked source tree. The command builds the frontend,
Hmux, remote helpers, CLI and native app. It writes
`src-tauri/target/release/bundle/macos/Dure.app` without publisher signing,
notarization or updater artifacts. It does not install or launch the app.
After a successful build, open it in place:

```sh
open src-tauri/target/release/bundle/macos/Dure.app
```

For a Finder installation, reveal the result with
`open -R src-tauri/target/release/bundle/macos/Dure.app`, then copy it into
`~/Applications` or `/Applications`. Check any replacement prompt if you already
have Dure installed. This packaged app uses Dure's normal application identity
and data; changing its filename does not create a separate development channel.
Use macOS's per-app approval if it asks to allow your local build, as described in
[the installation guide](https://docs.dureai.dev/en/install).

Rebuilding from source does not require publisher signing keys or GitHub
credentials; the pinned native inputs are downloaded from a public release and
verified. [Official downloads](https://www.dureai.dev/download/mac/) are available
for users who want the distributed build.

The build checks free disk space and concurrent reservations before it starts.
The current local full-build requirement is 110 GiB free, plus other active build
reservations. Follow the actual refusal message and inspect `pnpm disk:status`
instead of bypassing admission. The build budgets are defined in
[disk-space.mjs](scripts/lib/disk-space.mjs).

For frontend-only work, `pnpm build:frontend` builds the web UI. It does not
produce the native desktop app.

#### CLI during development

The macOS development launcher prepares a CLI for its own channel. Terminals
opened in that app receive the channel's tool paths. Use `dure --help` there, or
`node cli/dure.mjs --help` from the repository root to inspect source CLI usage.
See [cli/README.md](cli/README.md) for installation and bundle details. The
separate `pnpm dure:install` command installs the CLI; it does not install the
GUI and is not required before `pnpm app:dev`.

### Windows and Linux desktop

Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)
for your host. Windows requires the MSVC C++ tools and WebView2; Dure's bootstrap
also expects Git Bash and the x86_64 MSVC Rust host. Linux requires the GTK,
WebKitGTK and other packages checked by
[linux-desktop-doctor.sh](scripts/qa/linux-desktop-doctor.sh).

Complete the [shared setup](#development-installation), then run the doctor
for your native host:

```sh
# Windows x86_64, with MSVC and Git Bash available on PATH
pnpm app:windows:doctor
```

```sh
# Linux x86_64
pnpm app:linux:doctor
```

The Linux doctor prints the missing commands/packages and its Ubuntu install
command. A successful doctor verifies host prerequisites, not the complete
native artifact supply. The pinned Ghostty proof builder currently
requires a macOS ARM64 build host; a cold Windows/Linux desktop build needs the
matching prepared proof. Windows packaging also consumes prepared Linux remote
checkout helpers. Preserve the artifact receipts and digest checks when supplying
these inputs. Once those inputs are prepared, run the matching
`pnpm app:windows:verify` / `pnpm app:windows:build` or
`pnpm app:linux:verify` / `pnpm app:linux:build` commands. The build commands create
NSIS or Debian/AppImage packages respectively; they do not install them.

The source entrypoints do not yet constitute a verified standalone Windows/Linux
bootstrap; report missing prerequisites with the target and commit. Use the
[public source checks](#checks-and-review) for frontend and shared-code contributions
that do not require a native desktop build.

### iOS and Android

The mobile project has its own [package manifest](mobile/package.json) and
[lockfile](mobile/pnpm-lock.yaml). Install root dependencies first, then run:

```sh
pnpm --dir mobile install --frozen-lockfile
pnpm verify:push:mobile-web
```

This checks mobile lint, tests and its web build. For native development, follow
[Tauri's mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets):
iOS needs macOS with full Xcode; Android needs its SDK/NDK and Java toolchain.
Use your own signing/provisioning configuration. The checked-in iOS project
contains the Dure bundle ID and team; for a fork, configure your own identifier
and development team in Tauri and the native project. Select one native workflow:

```sh
# iOS device/simulator development through Tauri (macOS + Xcode)
pnpm --dir mobile tauri ios dev
```

```sh
# Android emulator or connected device (Android SDK/NDK + Java)
pnpm --dir mobile android:dev
```

The separate `pnpm --dir mobile ios:dev` wrapper builds a debug archive, verifies
its push-signing configuration, installs it on a physical iPhone and launches it.
It currently requires Dure's fixed `dev.hebbian.ide.mobile` App ID and a matching
APNs provisioning profile, as checked by
[ios-push-signing.mjs](scripts/ios-push-signing.mjs). It is intended for maintainers
with that provisioning; use the Tauri entrypoint above for a fork's configuration.
With multiple iPhones connected, maintainers can select one with
`pnpm --dir mobile ios:dev 'My iPhone'`.
Native projects already exist under `mobile/src-tauri/gen/`; review generated
project and signing changes before committing them.

For mobile Rust changes, use `pnpm verify:push:mobile-rust` on a suitably
provisioned host and run the relevant device/simulator smoke. Include the device,
OS/SDK versions, source commit and observed behavior in the pull request. An
iOS or Android release requires device acceptance and platform distribution
credentials; neither is supplied by the public CI jobs.

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
The [official macOS release guide](docs/maintainers/releasing.md) covers protected
signing, exact-source builds, compatibility feeds and publication recovery.

## Checks and review

The public workflow runs the same source checks available locally:

```sh
pnpm verify:frontend
pnpm test:scripts
pnpm verify:push:mobile-web
pnpm hub-protocol:verify
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
[public-repository.yml](.github/workflows/public-repository.yml). It runs for
pushes to `main`, pull requests targeting `main`, and manual dispatches.
Documentation-only changes run change classification and documentation checks;
code suites are skipped. Code, dependency and CI changes, uncertain comparisons,
and manual dispatches run the complete public checks. The existing
[scope classifier](scripts/lib/push-gate-scope.mjs) owns path classification.

The required `Public repository checks` result always runs. It requires successful
classification and documentation checks, plus every selected frontend, script,
mobile web and shared-protocol check. A failed classification or an unexpectedly
skipped, failed or cancelled required job cannot pass this result. Mobile web checks
run on Linux, and the shared desktop/mobile protocol is formatted, tested and
linted on Linux, Windows and macOS. These jobs use hosted runners with read-only
repository permissions; they do not use publisher credentials or maintainer
machines. Platform-native
desktop/mobile packaging and device acceptance remain separate checks.

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
[GNU GPL version 3 only (GPL-3.0-only) license](LICENSE). Contributions are
accepted under those terms. Preserve third-party licenses and identify the
source and license of any material you add.

The first-party license changed from MIT to GPL-3.0-only in
[the licensing transition](https://github.com/hebbianai/dure/issues/27). Earlier
versions released under MIT retain their original terms; this change does not
relicense copies already provided under MIT. When distributing covered binaries,
provide Corresponding Source as required by GPLv3.

See the [open-source boundary](README.md#open-source-boundary) for the scope of
this repository and [TRADEMARK.md](TRADEMARK.md) for project branding and official
builds. Independent builds and forks remain permitted under the source licenses;
identify their publisher clearly when distributing them.
