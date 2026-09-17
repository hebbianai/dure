use clap::Args;
use hmux_client::{LocalStateGcReport, SessionHealth};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub(crate) struct DoctorArgs {
    /// Total wall-clock budget shared by discovery census and exact probing.
    #[arg(long, default_value_t = 1_500, value_parser = clap::value_parser!(u64).range(0..=60_000))]
    pub(crate) probe_budget_ms: u64,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoctorReasonCount {
    pub(crate) reason: &'static str,
    pub(crate) count: usize,
}

#[derive(Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoctorSessionSummary {
    pub(crate) total: usize,
    pub(crate) healthy: usize,
    pub(crate) stale: usize,
    pub(crate) orphan: usize,
    pub(crate) indeterminate: usize,
    pub(crate) probe_targets: usize,
    pub(crate) probed: usize,
    pub(crate) unprobed: usize,
    pub(crate) probe_coverage_basis_points: u16,
    pub(crate) probe_complete: bool,
    pub(crate) oldest_orphan_age_ms: Option<u64>,
    pub(crate) reasons: Vec<DoctorReasonCount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDoctorReport {
    pub(crate) schema_version: u16,
    pub(crate) discovery_root: PathBuf,
    pub(crate) probe_budget_ms: u64,
    pub(crate) session_candidates: DoctorSessionSummary,
    pub(crate) state_gc: LocalStateGcReport,
}

pub(crate) fn session_summary(
    health: impl IntoIterator<Item = SessionHealth>,
    scanned_sessions: usize,
    eligible_orphans: usize,
    oldest_orphan_age_ms: Option<u64>,
) -> DoctorSessionSummary {
    let mut summary = DoctorSessionSummary::default();
    let mut reasons = BTreeMap::new();
    let mut listed_sessions = 0_usize;
    for status in health {
        listed_sessions = listed_sessions.saturating_add(1);
        let reason = match status {
            SessionHealth::Healthy => {
                summary.healthy = summary.healthy.saturating_add(1);
                summary.probe_targets = summary.probe_targets.saturating_add(1);
                summary.probed = summary.probed.saturating_add(1);
                "control_plane_healthy"
            }
            SessionHealth::StaleTransport => {
                summary.stale = summary.stale.saturating_add(1);
                summary.probe_targets = summary.probe_targets.saturating_add(1);
                summary.probed = summary.probed.saturating_add(1);
                "stale_transport"
            }
            SessionHealth::IncompatibleProtocol => {
                summary.stale = summary.stale.saturating_add(1);
                summary.probe_targets = summary.probe_targets.saturating_add(1);
                summary.probed = summary.probed.saturating_add(1);
                "incompatible_protocol"
            }
            SessionHealth::Exited => {
                summary.stale = summary.stale.saturating_add(1);
                "exited_receipt"
            }
            SessionHealth::GenerationChanged => {
                summary.indeterminate = summary.indeterminate.saturating_add(1);
                summary.probe_targets = summary.probe_targets.saturating_add(1);
                summary.probed = summary.probed.saturating_add(1);
                "generation_changed_during_probe"
            }
            SessionHealth::Unprobed => {
                summary.indeterminate = summary.indeterminate.saturating_add(1);
                summary.probe_targets = summary.probe_targets.saturating_add(1);
                summary.unprobed = summary.unprobed.saturating_add(1);
                "probe_budget_exhausted"
            }
        };
        *reasons.entry(reason).or_insert(0_usize) += 1;
    }
    let unlisted_sessions = scanned_sessions.saturating_sub(listed_sessions);
    summary.orphan = eligible_orphans.min(unlisted_sessions);
    if summary.orphan > 0 {
        reasons.insert("retired_generation_proven_absent", summary.orphan);
    }
    let unclassified = unlisted_sessions.saturating_sub(summary.orphan);
    summary.indeterminate = summary.indeterminate.saturating_add(unclassified);
    if unclassified > 0 {
        reasons.insert("unlisted_discovery_state", unclassified);
    }
    summary.total = listed_sessions.saturating_add(unlisted_sessions);
    summary.probe_complete = summary.unprobed == 0;
    summary.probe_coverage_basis_points = if summary.probe_targets == 0 {
        10_000
    } else {
        u16::try_from(
            summary
                .probed
                .saturating_mul(10_000)
                .checked_div(summary.probe_targets)
                .unwrap_or_default()
                .min(10_000),
        )
        .unwrap_or(10_000)
    };
    summary.oldest_orphan_age_ms = (summary.orphan > 0)
        .then_some(oldest_orphan_age_ms)
        .flatten();
    summary.reasons = reasons
        .into_iter()
        .map(|(reason, count)| DoctorReasonCount { reason, count })
        .collect();
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphan_proof_stays_separate_from_indeterminate_state() {
        let summary = session_summary(
            [
                SessionHealth::Healthy,
                SessionHealth::StaleTransport,
                SessionHealth::Exited,
                SessionHealth::Unprobed,
            ],
            7,
            1,
            Some(86_400_000),
        );

        assert_eq!(summary.total, 7);
        assert_eq!(summary.healthy, 1);
        assert_eq!(summary.stale, 2);
        assert_eq!(summary.orphan, 1);
        assert_eq!(summary.indeterminate, 3);
        assert_eq!(summary.probe_targets, 3);
        assert_eq!(summary.probed, 2);
        assert_eq!(summary.unprobed, 1);
        assert_eq!(summary.probe_coverage_basis_points, 6_666);
        assert!(!summary.probe_complete);
        assert_eq!(summary.oldest_orphan_age_ms, Some(86_400_000));
        assert!(summary.reasons.contains(&DoctorReasonCount {
            reason: "retired_generation_proven_absent",
            count: 1,
        }));
        assert!(summary.reasons.contains(&DoctorReasonCount {
            reason: "unlisted_discovery_state",
            count: 2,
        }));
    }

    #[test]
    fn empty_probe_target_set_is_complete_without_division_by_zero() {
        let summary = session_summary([SessionHealth::Exited], 1, 0, None);

        assert_eq!(summary.probe_targets, 0);
        assert_eq!(summary.probed, 0);
        assert_eq!(summary.unprobed, 0);
        assert_eq!(summary.probe_coverage_basis_points, 10_000);
        assert!(summary.probe_complete);
    }
}
