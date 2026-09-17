//! Project a manifest state plus an exact probe result into what a user can
//! actually expect when attaching (hebbian-frontend-u0h6).
//!
//! A catalog `ready` only says a Host published a ready manifest. A live audit
//! (2026-07-29) found 37 such sessions of which only 11 answered an exact
//! transport probe; 25 could be lazily restarted from a verified recipe and one
//! had neither a Host nor a recipe. The list rendered all three identically, so
//! nothing distinguished "attach resumes bytes", "attach restarts the program",
//! and "attach fails".
//!
//! This module keeps that judgement pure and provider-neutral: callers supply
//! the manifest facts and the probe outcome, and get back a state plus a
//! recoverability verdict whose reasons are stable neutral codes.

use crate::SessionProbeStatus;
use crate::session::SessionLifecycle;

/// What the runtime is doing right now, as opposed to what the manifest claims.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LivenessState {
    /// An exact probe completed: attaching resumes the live byte stream.
    Live,
    /// The manifest is ready but the transport did not answer. Attaching cannot
    /// resume bytes; it can only restart when a recipe allows it.
    Stale,
    /// The Host answered but speaks a protocol this client cannot negotiate.
    IncompatibleProtocol,
    /// The Host published an exited lifecycle. Nothing is running.
    Exited,
    /// No probe was performed (bounded scan gave up, or probing was disabled).
    /// Never claim health from an absent probe.
    Unprobed,
}

/// Whether the user can get back to work, and at what cost.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Recoverability {
    /// Already live — attaching resumes the existing bytes.
    LiveAttach,
    /// Not live, but a verified recipe can restart it without asking.
    AutomaticRestart,
    /// Restartable, but replaying an explicit command needs confirmation.
    RestartNeedsConfirmation,
    /// No advertised automatic path can bring it back. The reason is a stable
    /// neutral code.
    Unrecoverable { reason: &'static str },
    /// Recoverability could not be determined because liveness was not probed.
    Unknown,
}

/// The manifest-side facts this projection needs. Kept explicit so the
/// projection stays pure and the caller owns manifest interpretation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionLivenessInput {
    pub lifecycle: SessionLifecycle,
    /// The adapter has an automatic recovery path for this session kind.
    pub automatic_recovery_supported: bool,
    /// A recorded resurrection recipe that was verified, not inferred.
    pub verified_recipe: bool,
    /// Restarting would replay an explicit command the user typed.
    pub replays_explicit_command: bool,
    /// Probe outcome, or `None` when no probe ran.
    pub probe: Option<SessionProbeStatus>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionLiveness {
    pub state: LivenessState,
    pub recoverability: Recoverability,
}

/// Neutral reason codes. They match the recovery policy vocabulary so a list
/// entry and a refused recovery explain a failure the same way.
pub const REASON_NO_RECIPE: &str = "verified_resurrection_recipe_required";
pub const REASON_EXITED_WITHOUT_RECIPE: &str = "exited_without_verified_recipe";
pub const REASON_PROTOCOL_UNSUPPORTED: &str = "hmux_protocol_version_unsupported";
pub const REASON_AUTOMATIC_RECOVERY_UNSUPPORTED: &str = "automatic_recovery_unsupported";

#[must_use]
pub fn project_session_liveness(input: SessionLivenessInput) -> SessionLiveness {
    let state = match (input.lifecycle, input.probe) {
        (SessionLifecycle::Exited, _) => LivenessState::Exited,
        (_, None) => LivenessState::Unprobed,
        (_, Some(SessionProbeStatus::Healthy)) => LivenessState::Live,
        (_, Some(SessionProbeStatus::IncompatibleProtocol)) => LivenessState::IncompatibleProtocol,
        (_, Some(SessionProbeStatus::Exited)) => LivenessState::Exited,
        (_, Some(SessionProbeStatus::GenerationChanged)) => LivenessState::Unprobed,
        (_, Some(SessionProbeStatus::StaleTransport)) => LivenessState::Stale,
    };
    SessionLiveness {
        state,
        recoverability: recoverability_for(state, input),
    }
}

fn recoverability_for(state: LivenessState, input: SessionLivenessInput) -> Recoverability {
    match state {
        LivenessState::Live => Recoverability::LiveAttach,
        // An absent probe is not evidence of anything. Reporting a restart plan
        // here would be a guess the user could not tell apart from a fact.
        LivenessState::Unprobed => Recoverability::Unknown,
        LivenessState::IncompatibleProtocol => Recoverability::Unrecoverable {
            reason: REASON_PROTOCOL_UNSUPPORTED,
        },
        LivenessState::Exited if !input.verified_recipe => Recoverability::Unrecoverable {
            reason: REASON_EXITED_WITHOUT_RECIPE,
        },
        _ if !input.automatic_recovery_supported => Recoverability::Unrecoverable {
            reason: REASON_AUTOMATIC_RECOVERY_UNSUPPORTED,
        },
        _ if !input.verified_recipe => Recoverability::Unrecoverable {
            reason: REASON_NO_RECIPE,
        },
        _ if input.replays_explicit_command => Recoverability::RestartNeedsConfirmation,
        _ => Recoverability::AutomaticRestart,
    }
}

/// Stable machine-readable names. The CLI emits these verbatim so scripts do
/// not parse prose.
#[must_use]
pub const fn liveness_state_name(state: LivenessState) -> &'static str {
    match state {
        LivenessState::Live => "live",
        LivenessState::Stale => "stale",
        LivenessState::IncompatibleProtocol => "incompatible_protocol",
        LivenessState::Exited => "exited",
        LivenessState::Unprobed => "unprobed",
    }
}

#[must_use]
pub const fn recoverability_name(recoverability: Recoverability) -> &'static str {
    match recoverability {
        Recoverability::LiveAttach => "live_attach",
        Recoverability::AutomaticRestart => "automatic_restart",
        Recoverability::RestartNeedsConfirmation => "restart_needs_confirmation",
        Recoverability::Unrecoverable { .. } => "unrecoverable",
        Recoverability::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        lifecycle: SessionLifecycle,
        probe: Option<SessionProbeStatus>,
        verified_recipe: bool,
    ) -> SessionLivenessInput {
        SessionLivenessInput {
            lifecycle,
            automatic_recovery_supported: true,
            verified_recipe,
            replays_explicit_command: false,
            probe,
        }
    }

    #[test]
    fn a_probe_that_answers_means_attaching_resumes_bytes() {
        let liveness = project_session_liveness(input(
            SessionLifecycle::Ready,
            Some(SessionProbeStatus::Healthy),
            false,
        ));
        assert_eq!(liveness.state, LivenessState::Live);
        assert_eq!(liveness.recoverability, Recoverability::LiveAttach);
    }

    /// The audit case: ready manifest, silent transport, verified recipe. The
    /// list used to render this exactly like a live session.
    #[test]
    fn a_ready_manifest_with_a_silent_transport_is_stale_but_restartable() {
        let liveness = project_session_liveness(input(
            SessionLifecycle::Ready,
            Some(SessionProbeStatus::StaleTransport),
            true,
        ));
        assert_eq!(liveness.state, LivenessState::Stale);
        assert_eq!(liveness.recoverability, Recoverability::AutomaticRestart);
    }

    /// The other audit case: nothing answers and nothing can rebuild it.
    #[test]
    fn a_stale_session_without_a_recipe_is_unrecoverable() {
        let liveness = project_session_liveness(input(
            SessionLifecycle::Ready,
            Some(SessionProbeStatus::StaleTransport),
            false,
        ));
        assert_eq!(
            liveness.recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_NO_RECIPE
            }
        );
    }

    #[test]
    fn replaying_an_explicit_command_requires_confirmation() {
        let liveness = project_session_liveness(SessionLivenessInput {
            replays_explicit_command: true,
            ..input(
                SessionLifecycle::Ready,
                Some(SessionProbeStatus::StaleTransport),
                true,
            )
        });
        assert_eq!(
            liveness.recoverability,
            Recoverability::RestartNeedsConfirmation
        );
    }

    #[test]
    fn an_exited_session_reports_exited_regardless_of_any_probe() {
        for probe in [
            None,
            Some(SessionProbeStatus::Healthy),
            Some(SessionProbeStatus::StaleTransport),
            Some(SessionProbeStatus::Exited),
            Some(SessionProbeStatus::GenerationChanged),
        ] {
            assert_eq!(
                project_session_liveness(input(SessionLifecycle::Exited, probe, true)).state,
                LivenessState::Exited
            );
        }
    }

    #[test]
    fn a_generation_change_requires_a_fresh_census_instead_of_restart() {
        let liveness = project_session_liveness(input(
            SessionLifecycle::Ready,
            Some(SessionProbeStatus::GenerationChanged),
            true,
        ));
        assert_eq!(liveness.state, LivenessState::Unprobed);
        assert_eq!(liveness.recoverability, Recoverability::Unknown);
    }

    #[test]
    fn an_exited_probe_result_overrides_a_ready_manifest() {
        let liveness = project_session_liveness(input(
            SessionLifecycle::Ready,
            Some(SessionProbeStatus::Exited),
            false,
        ));
        assert_eq!(liveness.state, LivenessState::Exited);
        assert_eq!(
            liveness.recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_EXITED_WITHOUT_RECIPE
            }
        );
    }

    #[test]
    fn an_exited_session_without_a_recipe_says_so_specifically() {
        assert_eq!(
            project_session_liveness(input(SessionLifecycle::Exited, None, false)).recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_EXITED_WITHOUT_RECIPE
            }
        );
    }

    #[test]
    fn an_unspeakable_host_without_a_recipe_names_the_protocol() {
        assert_eq!(
            project_session_liveness(input(
                SessionLifecycle::Ready,
                Some(SessionProbeStatus::IncompatibleProtocol),
                false,
            ))
            .recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_PROTOCOL_UNSUPPORTED
            }
        );
    }

    #[test]
    fn a_recipe_cannot_turn_an_incompatible_host_into_an_automatic_restart() {
        assert_eq!(
            project_session_liveness(input(
                SessionLifecycle::Ready,
                Some(SessionProbeStatus::IncompatibleProtocol),
                true,
            ))
            .recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_PROTOCOL_UNSUPPORTED
            }
        );
    }

    #[test]
    fn a_recipe_cannot_authorize_an_unsupported_recovery_adapter() {
        assert_eq!(
            project_session_liveness(SessionLivenessInput {
                automatic_recovery_supported: false,
                ..input(
                    SessionLifecycle::Ready,
                    Some(SessionProbeStatus::StaleTransport),
                    true,
                )
            })
            .recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_AUTOMATIC_RECOVERY_UNSUPPORTED
            }
        );
    }

    #[test]
    fn audit_fixture_distinguishes_25_lazy_restarts_from_one_legacy_session() {
        let projected = (0..26)
            .map(|index| {
                project_session_liveness(SessionLivenessInput {
                    automatic_recovery_supported: index < 25,
                    ..input(
                        SessionLifecycle::Ready,
                        Some(SessionProbeStatus::StaleTransport),
                        true,
                    )
                })
            })
            .collect::<Vec<_>>();

        assert_eq!(
            projected
                .iter()
                .filter(|entry| entry.recoverability == Recoverability::AutomaticRestart)
                .count(),
            25
        );
        assert_eq!(
            projected[25].recoverability,
            Recoverability::Unrecoverable {
                reason: REASON_AUTOMATIC_RECOVERY_UNSUPPORTED
            }
        );
    }

    /// A skipped probe must never be read as health, and must not imply a plan.
    #[test]
    fn an_unprobed_session_claims_neither_health_nor_a_restart_plan() {
        let liveness = project_session_liveness(input(SessionLifecycle::Ready, None, true));
        assert_eq!(liveness.state, LivenessState::Unprobed);
        assert_eq!(liveness.recoverability, Recoverability::Unknown);
    }

    #[test]
    fn names_are_stable_for_scripts() {
        assert_eq!(liveness_state_name(LivenessState::Live), "live");
        assert_eq!(liveness_state_name(LivenessState::Unprobed), "unprobed");
        assert_eq!(
            recoverability_name(Recoverability::Unrecoverable { reason: "x" }),
            "unrecoverable"
        );
        assert_eq!(recoverability_name(Recoverability::Unknown), "unknown");
    }
}
