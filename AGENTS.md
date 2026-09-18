# AGENTS.md — Dure

This guide applies to coding agents working in the public Dure repository.
Follow explicit user instructions and any closer-scoped `AGENTS.md` for the files
you change. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup,
platform prerequisites, checks and contribution policy. Use the versions pinned
in the repository and commands defined in [package.json](package.json).

## Working on a change

- Keep changes focused on the requested behavior. Read the existing implementation,
  its callers and tests before editing.
- Work in your own task checkout. Preserve other contributors' uncommitted work
  and commits. For concurrent work, record the agent, branch, worktree and bounded
  scope on the related issue before editing shared files.
- Follow the [branch and PR workflow](CONTRIBUTING.md#branches-and-releases) and
  [merge policy](CONTRIBUTING.md#checks-and-review). Review the complete diff and
  run `git diff --check` before submitting. Never force-push or rewrite `main`.

## Implementation and UI

- Prioritize flexibility and extensibility through simple, reusable structures.
  Follow the shared [code design principles](CONTRIBUTING.md#code-design) for
  reuse, composition, dependency boundaries and justified abstraction.
- Keep shared durable session and execution facts in [Hmux](hmux/). Keep IDE
  selection, layout and focus state in the frontend, and OS/process mechanics in
  the thin [Tauri adapter](src-tauri/). Build on the existing application services
  in [crates/](crates/) instead of adding a second owner for the same state.
- Normalize input at the boundary and use typed identities and capabilities.
  Views consume authoritative state; they must not invent competing state
  machines or treat an unreachable runtime as proof that its processes exited.
- Reuse [UI primitives](src/components/ui/) and the existing domain components.
  Follow the [design charter](design/SOUL.md) and existing tokens. Keep rendering
  and wiring in components, and pure frontend logic in `src/lib/` with colocated
  behavior tests.
- English is canonical product copy. Use the client's existing translation
  system and semantic keys. Desktop copy uses `t()` and all seven locales in
  [src/locales/](src/locales/); mobile changes must update the locales supported
  by [mobile/src/locales/](mobile/src/locales/). Do not add a parallel fallback.
- Code and behavioral tests define implementation contracts. Keep plans,
  decisions and handoffs on the related issue rather than adding duplicate
  architecture or task-status catalogs.

## Platforms and compatibility

- Consider macOS, Windows, Linux, iOS and Android when changing shared behavior.
  See [platform setup and verification](CONTRIBUTING.md#platforms) for the current
  scope of each client; source availability alone does not prove native support.
- Use existing platform adapters for paths, shells, process handling and keyboard
  shortcuts. Do not assume a Unix shell, macOS modifier keys or desktop-only
  input. Keep OS-specific code behind the appropriate platform boundary.
- Preserve local and remote execution boundaries. Desktop, mobile and remote
  runtimes can update independently; changes to shared protocols must preserve
  supported compatibility and use existing version/capability negotiation.

## Verification and runtime safety

- Use the [checks and review guide](CONTRIBUTING.md#checks-and-review) to select
  checks relevant to the change. Documentation and cosmetic edits do not need a
  new regression test or an application build merely to submit the change.
- For a bug fix, reproduce the behavior before the change and verify the same
  observation afterward. Terminal/session changes need the matching native smoke;
  WebView, focus, timing and multi-window changes need real integration evidence.
  Unit tests and successful compilation alone do not prove those behaviors.
- Do not weaken lint rules, warnings, baselines or behavioral coverage to pass a
  check. Update lockfiles through the appropriate package manager, and regenerate
  build output and staged runtimes through their existing commands.
- Run runtime QA with disposable `HOME`, `DURE_HOME` and a unique
  `HMUX_DISCOVERY_ROOT` through the existing QA runners. An app channel alone is
  not a sandbox. Do not replace a user's live app, steal desktop focus or stop
  unowned processes. Foreground interaction tests need an isolated environment
  or an explicitly arranged test window.
- Respect build storage admission. Use the repository's cleanup tools for
  generated artifacts; other worktrees and user data are not cleanup targets.
- Report the commands run, observed results and limitations. Distinguish fixture,
  native app, device and release evidence, and name platforms not tested.

## Public source and releases

- Follow the [open-source boundary](README.md#open-source-boundary). Keep private
  plans, operational records, credentials and signing keys out of committed files
  and shared logs, screenshots and pull requests. Use [SECURITY.md](SECURITY.md)
  for vulnerabilities.
- Preserve [LICENSE](LICENSE), copyright and third-party notices. Follow
  [TRADEMARK.md](TRADEMARK.md) when identifying forks and community builds.
- Maintainers manage version bumps, signing and official publication. Include
  release changes only when requested; a source build or green CI result is not
  evidence that an official release was published.
