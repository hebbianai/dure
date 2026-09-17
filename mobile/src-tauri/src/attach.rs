//! What a relayed attach from this client may and may not reach.
//!
//! Two things live here, and both are refusals rather than features:
//!
//! 1. [`WITHHELD_OVER_RELAY`] — capabilities this client never requests over a
//!    relay, named by the protocol crate's own constants.
//! 2. [`limitations`] — what is still true about this build now that the
//!    attach path works, surfaced to the UI so the session screen states it
//!    instead of implying a finished product.
//!
//! The blocker list this module used to carry is gone: `hmux-ssh-transport`,
//! `hmux mobile-gateway` and `LocalConnection::attach_over_transport` are all
//! on main, and this app attaches through them. What replaced it is shorter
//! and deliberately not empty — a working attach reads as far more finished
//! than this is.

use hmux_host::local_protocol::{
    AGENT_STATE_REPORT_CAPABILITY, SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY,
};
use serde::Serialize;

/// Capabilities that stay premised on colocation and are therefore never
/// requested over a relay, whatever `AttachMode` the attach uses.
///
/// Controller authority is premised on a gateway-minted grant — a phone typing
/// is the point, and Controller writes are arbitrated by a generation-fenced
/// lease. These three have no such arbitration:
///
/// - `shared_terminal_input` is an unarbitrated PTY write. Its writers do not
///   carry a live generation, so a keystroke buffered behind a stalled SSH
///   window executes against whatever the PTY has become.
/// - `standalone_termination_v1` signals pids, and a pid only means something
///   on the kernel that issued it. Over a relay it names a process on the
///   wrong machine.
/// - `agent_state_report_v1` is granted to a proof-less observer, so there is
///   no second factor on the standalone path to fall back to.
///
/// **This list is a client-side refusal, not the enforcement point.** The
/// gateway refuses a relayed `Hello` that asks for any of them, and
/// `hmux-client` refuses a relayed *grant* of one; those are the gates. A
/// client that never asks does not stop a client that does, so treating this
/// constant as the gate would be exactly the "a gate that cannot fail" mistake
/// this effort already made once.
pub const WITHHELD_OVER_RELAY: [&str; 3] = [
    SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY,
];

/// Drops the colocation-premised capabilities from a requested set.
#[must_use]
pub fn relay_safe_capabilities(requested: &[&str]) -> Vec<String> {
    requested
        .iter()
        .filter(|capability| !WITHHELD_OVER_RELAY.contains(*capability))
        .map(|capability| (*capability).to_string())
        .collect()
}

/// Something this build cannot do, stated on the screen where it matters.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Limitation {
    /// The attach is an observer attach and no input path is wired. Typing
    /// depends on the controller lease, which has no TTL, heartbeat or renew —
    /// and a backgrounded phone is exactly the client that would strand one.
    ReadOnly,
    /// The SSH private key is an ordinary file in app storage, not a Secure
    /// Enclave / Keystore key. See `identity_store` and `device_identity`.
    SoftwareKey,
    /// The gateway mints no scoped grant, so `Hello.capability_token` carries
    /// a placeholder and the SSH key is the whole of the authority — nothing
    /// here is revocable short of editing `authorized_keys`.
    NoScopedGrant,
    /// The single `authorized_keys` line `hmux pair` installs reaches **every**
    /// session that account owns on that server, not one.
    ///
    /// This replaced a different limitation, and the history is worth keeping
    /// because it is why the current shape looks loose. The default forced
    /// command is `"$HOME/.local/bin/hmux" mobile-gateway`, with neither
    /// `--session` nor `--list`, and `command="…"` *replaces* whatever the
    /// client asked to run — so while `--session` was required, that line exited
    /// on a clap usage error before any session was touched and the key could
    /// neither list nor attach. The narrow alternative, keys pinned to one
    /// session id, dies with the next Host: the id moves, and pairing is meant
    /// to happen once.
    ///
    /// So the project owner widened the key deliberately: unpinned, and
    /// therefore account-wide on that host. What still bounds it is the forced
    /// command plus `restrict` — no shell, no port forwarding, no other program
    /// — and `hmux pair revoke`, which removes the key from every host it
    /// reached. What does not bound it is this phone's lock screen, which is
    /// exactly why the reach is said out loud on the screen rather than left in
    /// a design note.
    PairedKeyReachesEverySession,
}

impl Limitation {
    /// Korean is the UI source language for this repo; the English strings
    /// live in `mobile/src/locales/en.ts`, keyed by the Korean text.
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            Self::ReadOnly => "읽기 전용입니다 — 입력은 아직 연결되지 않았습니다",
            Self::SoftwareKey => {
                "SSH 개인키가 앱 저장소에 평문으로 저장됩니다 — 하드웨어 보관이 아닙니다"
            }
            Self::NoScopedGrant => {
                "게이트웨이가 범위 제한 권한을 발급하지 않습니다 — SSH 키가 유일한 권한입니다"
            }
            Self::PairedKeyReachesEverySession => {
                "페어링 키 한 줄이 그 서버 계정의 모든 세션에 닿습니다 — \
                 세션 하나로 좁혀지지 않습니다"
            }
        }
    }
}

/// Everything this build still cannot do, in the order it matters to a user.
///
/// `writable` is the authority the *current* attach was admitted at, not a
/// build flag. Read-only is a property of one connection: the same build
/// attaches either way depending on what the forced command's ceiling allows,
/// and a screen that keeps saying "read-only" while the user is typing is the
/// drift this list exists to prevent.
#[must_use]
pub fn limitations(writable: bool) -> Vec<Limitation> {
    let mut reported = Vec::new();
    if !writable {
        reported.push(Limitation::ReadOnly);
    }
    reported.extend([
        Limitation::SoftwareKey,
        Limitation::NoScopedGrant,
        Limitation::PairedKeyReachesEverySession,
    ]);
    reported
}

#[derive(Clone, Debug, Serialize)]
pub struct LimitationReport {
    pub kind: Limitation,
    pub message: &'static str,
}

#[must_use]
pub fn limitation_reports(writable: bool) -> Vec<LimitationReport> {
    limitations(writable)
        .into_iter()
        .map(|kind| LimitationReport {
            kind,
            message: kind.message(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_colocation_premised_capabilities_are_never_requested() {
        let requested = [
            "working_directory_projection_v1",
            SHARED_TERMINAL_INPUT_CAPABILITY,
            STANDALONE_TERMINATION_CAPABILITY,
            AGENT_STATE_REPORT_CAPABILITY,
        ];

        let permitted = relay_safe_capabilities(&requested);

        assert_eq!(permitted, vec!["working_directory_projection_v1"]);
    }

    /// The two that would be most tempting to quietly drop once attaching
    /// works, which is why they are asserted rather than merely listed.
    #[test]
    fn read_only_and_the_software_key_are_still_reported() {
        let reported = limitations(false);

        assert!(reported.contains(&Limitation::ReadOnly), "{reported:?}");
        assert!(reported.contains(&Limitation::SoftwareKey), "{reported:?}");
    }

    /// The other half of the same property. A writable attach must stop
    /// claiming it cannot type — and must keep every limitation that has
    /// nothing to do with typing, because "input works now" is not evidence
    /// about the key or the grant.
    #[test]
    fn a_writable_attach_drops_only_the_read_only_claim() {
        let reported = limitations(true);

        assert!(!reported.contains(&Limitation::ReadOnly), "{reported:?}");
        assert!(reported.contains(&Limitation::SoftwareKey), "{reported:?}");
        assert!(
            reported.contains(&Limitation::NoScopedGrant),
            "{reported:?}"
        );
        assert!(
            reported.contains(&Limitation::PairedKeyReachesEverySession),
            "{reported:?}"
        );
    }

    #[test]
    fn every_limitation_carries_a_message() {
        for writable in [false, true] {
            assert!(limitation_reports(writable)
                .iter()
                .all(|entry| !entry.message.is_empty()));
        }
    }
}
