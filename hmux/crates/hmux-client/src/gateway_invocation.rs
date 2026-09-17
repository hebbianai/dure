//! The one spelling of "run the gateway on that box".
//!
//! Two places need this string and they are in different crates: `hmux pair`
//! writes it into `authorized_keys` as a forced command, and a relay client
//! sends it as the SSH exec command. They were separate literals, and one of
//! them named the binary without a path.
//!
//! On a host where the forced command applies that difference is invisible,
//! because sshd discards whatever the client asked for and runs the pinned line
//! instead. It stops being invisible the moment something else authenticates
//! the connection — Tailscale SSH is the case that found this, since it serves
//! the session itself and never reads `authorized_keys`. There the client's own
//! string is what runs, `hmux` is not on a non-interactive `PATH`, and the
//! session dies with `command not found` after authenticating perfectly.
//!
//! Observed 2026-07-29 against a real tailnet host: identical phone, identical
//! paired key, worked on the plain-sshd server and failed on the Tailscale one.
//!
//! So the invocation is absolute, and it is one constant rather than two equal
//! ones. Two literals that must match are a drift waiting to happen, and this
//! particular drift is silent on every host anyone would think to test.
//!
//! It lives in `hmux-client` because that is what both sides already depend on.
//! The obvious alternative — have `hmux-cli` depend on `hmux-ssh-transport` —
//! would pull russh and ring into the CLI, and ring's build script needs a C
//! cross-toolchain that the musl artifact job deliberately does not have.

/// How the gateway is invoked on the session-owning box.
///
/// The program is quoted so a home directory containing a space survives the
/// remote shell, and `$HOME` is left for that shell to expand: the installing
/// side does not know the remote account's home, and hard-coding one would make
/// the line wrong for every host whose layout differs.
pub const GATEWAY_INVOCATION: &str = "\"$HOME/.local/bin/hmux\" mobile-gateway";

/// Writable controller gateway requested by an ordinary SSH exec client.
///
/// An `authorized_keys` forced command may deliberately replace this with an
/// observer-only ceiling. In that deployment the attach is refused rather
/// than silently widening the paired key.
pub const CONTROLLER_GATEWAY_INVOCATION: &str =
    "\"$HOME/.local/bin/hmux\" mobile-gateway --role controller";

/// The forced command for one pairing's two choices.
///
/// Composed here rather than spelled at each call site for the reason this
/// module exists: the string is what sshd runs, and a near-miss written by hand
/// is a line that looks right and grants something else. Four combinations of
/// two answers is exactly the kind of table that goes stale as four constants.
///
/// `writable` is the phone typing rather than watching. `allow_create` is the
/// phone starting a session on that box rather than only reaching the ones that
/// already run — the two are separate questions, and a phone that may type but
/// not start is a coherent (and, until the owner asked otherwise, the only)
/// deployment.
#[must_use]
pub fn pairing_invocation(writable: bool, allow_create: bool) -> String {
    let mut invocation = if writable {
        CONTROLLER_GATEWAY_INVOCATION.to_string()
    } else {
        GATEWAY_INVOCATION.to_string()
    };
    if allow_create {
        invocation.push_str(" --allow-create");
    }
    invocation
}

/// Read-only CLI identity/capability census on the execution host.
///
/// This uses the same absolute installation boundary as the gateway. A forced
/// command is allowed to replace it; callers must then treat the non-JSON or
/// timed-out result as a typed defer, never as installation authority.
pub const CAPABILITIES_INVOCATION: &str = "\"$HOME/.local/bin/hmux\" capabilities --json";

#[cfg(test)]
mod tests {
    use super::*;

    /// The four lines one pairing can write. Spelled out because each is a
    /// string sshd executes, and a flag that lands in the wrong order or with
    /// the wrong spacing is a line that runs something else.
    #[test]
    fn a_pairing_composes_exactly_the_line_its_two_answers_mean() {
        assert_eq!(pairing_invocation(false, false), GATEWAY_INVOCATION);
        assert_eq!(
            pairing_invocation(true, false),
            CONTROLLER_GATEWAY_INVOCATION
        );
        assert_eq!(
            pairing_invocation(false, true),
            format!("{GATEWAY_INVOCATION} --allow-create")
        );
        assert_eq!(
            pairing_invocation(true, true),
            format!("{CONTROLLER_GATEWAY_INVOCATION} --allow-create")
        );
    }

    /// The property that matters is not the spelling, it is that the program is
    /// reachable without a `PATH`. A relative name here is the bug this module
    /// exists to prevent, and it only shows up on hosts that bypass the forced
    /// command.
    #[test]
    fn the_program_is_absolute_so_it_does_not_depend_on_path() {
        let program = GATEWAY_INVOCATION
            .split_ascii_whitespace()
            .next()
            .expect("the invocation must name a program");
        let unquoted = program.trim_matches('"');
        assert!(
            unquoted.starts_with('/') || unquoted.starts_with("$HOME/"),
            "the program must resolve without PATH, got {program}"
        );
        assert!(
            program.starts_with('"') && program.ends_with('"'),
            "the program must stay quoted so a home directory with a space survives, got {program}"
        );
    }

    /// A forced command replaces the client's argv wholesale, so anything this
    /// line requires and does not supply can never be supplied by the phone.
    #[test]
    fn the_invocation_carries_no_arguments_the_caller_would_have_to_add() {
        let arguments: Vec<&str> = GATEWAY_INVOCATION
            .split_ascii_whitespace()
            .skip(1)
            .collect();
        assert_eq!(
            arguments,
            vec!["mobile-gateway"],
            "the subcommand and nothing else: every other argument would be one \
             a forced-command client cannot append"
        );
    }

    #[test]
    fn the_controller_invocation_requests_the_explicit_writable_ceiling() {
        assert_eq!(
            CONTROLLER_GATEWAY_INVOCATION,
            format!("{GATEWAY_INVOCATION} --role controller")
        );
    }

    #[test]
    fn capability_preflight_is_absolute_and_read_only() {
        assert_eq!(
            CAPABILITIES_INVOCATION,
            "\"$HOME/.local/bin/hmux\" capabilities --json"
        );
        assert!(!CAPABILITIES_INVOCATION.contains("install"));
        assert!(!CAPABILITIES_INVOCATION.contains("upgrade"));
    }
}
