# Security policy

## Report a vulnerability privately

Use GitHub's **[Report a vulnerability](https://github.com/hebbianai/dure/security/advisories/new)**
form to contact the Dure maintainers privately. A GitHub account is required.
Private vulnerability reporting is enabled for this repository.

Please do not disclose exploit details in a public issue or pull request before
coordinating with the maintainers. Include:

- The affected Dure version and how it was installed.
- Your operating system, architecture and relevant configuration.
- Reproduction steps or a minimal proof of concept using disposable data.
- The potential impact and any workaround you have found.

Remove real tokens, private keys, personal conversations and customer data from
your report. Do not test against another person's accounts or systems.

## Scope and updates

Reports may concern Dure's macOS, Windows and Linux desktop source, iOS and
Android mobile source, shared components, or distributed applications. Include
the source commit for source builds and the device or simulator for mobile
reports.

Include the exact affected version. Maintainers assess the report, coordinate
fixes and agree on disclosure through the private report. There is currently no
published long-term support or backport schedule for older releases.

Use the [official download page](https://www.dureai.dev/download/mac/) for app
updates. Ordinary bugs and feature requests belong in
[public issues](https://github.com/hebbianai/dure/issues/new/choose).

## Dependency advisories

Advisories against third-party packages are tracked in the repository, not
answered case by case. The public CI workflow's **Dependency advisories** job
([`.github/workflows/public-repository.yml`](.github/workflows/public-repository.yml))
runs `cargo audit` against the shipped Cargo lockfiles (`src-tauri`,
`crates/dure-app`, `hmux` and `mobile/src-tauri`) on every code change; an
advisory that does not apply is ignored there by id, next to its reason.
`pnpm audit --prod` is kept free of critical and high findings for the npm
trees that ship or build the product (the repository root, `mobile/` and the
control-plane claude driver), and the pull request that last refreshed a
lockfile records what remained and why. [Dependabot](.github/dependabot.yml)
opens weekly, grouped update pull requests for npm, Cargo and GitHub Actions,
and the repository's Dependabot alerts list any open advisory against a
tracked lockfile. A dependency vulnerability with user impact is still
reported through the private form above.
