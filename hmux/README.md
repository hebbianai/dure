# Hmux

Hmux is Dure's provider-neutral session runtime. Clients attach to one Host's
process and terminal state; closing a view does not stop that process. The
name is a codename, not a session identity or capability.

This directory is the writable source. The original import and attribution
remain in [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md). Do not make parallel
feature edits in the old downstream mirror.

| Responsibility | Source and adjacent tests |
| --- | --- |
| Workspace, dependencies and toolchain | [Cargo.toml](Cargo.toml) |
| Shared session and terminal contracts | [session protocol](crates/hmux-session-protocol/src/lib.rs), [terminal protocol](crates/terminal-state-protocol/) |
| Host execution and terminal state | [runtime](crates/hmux-runtime/src/), [Host](crates/hmux-host/src/) |
| Client and reference CLI | [client](crates/hmux-client/src/), [CLI](crates/hmux-cli/src/) |
| Product build and behavior QA | [package scripts](../package.json), [QA runners](../scripts/qa/) |

From the repository root, `pnpm hmux:install` explicitly installs and activates
the reference CLI; use its `--help` for current commands. Development and release
entry points select their own artifacts through the build scripts.

Start with Dure's [contribution guide](https://github.com/hebbianai/dure/blob/main/CONTRIBUTING.md)
for contribution and verification requirements. Discuss bug reports and proposals
in [GitHub Issues](https://github.com/hebbianai/dure/issues).
