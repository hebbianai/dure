//! Asking every server, directly, what sessions it is running.
//!
//! After pairing the laptop is gone. There is no index, no broker and nothing
//! to ask "where are my sessions" — the phone holds a list of servers and it
//! talks to each of them itself, over its own SSH connection, with its own
//! pinned host key. This module is the fan-out.
//!
//! ## The failure this module exists to prevent
//!
//! **A missing session reads as a dead session.** If one box is slow, off the
//! network, or has no `hmux` on its `PATH`, the naive shape — gather what came
//! back, show it — produces a shorter list with nothing to distinguish it from
//! a correct one. The user sees that the agent they left running last night is
//! not there and concludes it died. So:
//!
//! - every server in the list produces exactly one [`ServerReport`], always,
//!   including the ones that never answered and the ones that were never
//!   reached at all;
//! - a server that runs out of budget is [`ProbeOutcome::TimedOut`], not
//!   absent;
//! - a server the scheduler never got to before the overall deadline is
//!   [`ProbeOutcome::NotAttempted`], which is a different sentence from "that
//!   box did not answer" and belongs to a different fix.
//!
//! ## Not provisioned is not a protocol failure
//!
//! A box without `hmux` answers the exec channel with a shell's
//! `hmux: command not found` on stderr and closes. That is a complete, healthy
//! SSH session carrying a perfectly clear message, and reporting it as a
//! protocol or transport fault sends the user to look at the network. It is
//! classified as [`ProbeOutcome::NotProvisioned`], whose fix is on the server's
//! `PATH`.
//!
//! ## Why the scheduler is generic over the probe
//!
//! The interesting behaviour here is scheduling under two deadlines with
//! bounded parallelism, and none of it involves SSH. Taking the probe as a
//! closure is what makes "one wedged server does not remove the others" and
//! "every server is accounted for" testable at all — against a fake probe that
//! blocks, rather than against a lab that would have to be *made* to wedge.

use crate::catalog::DiscoveredSession;
use crate::relay::RelayError;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How many servers this client dials at once.
///
/// Four, matching the desktop's own census width (`MAX_CENSUS_WORKERS`). The
/// bound is about the device, not the servers: each worker holds an SSH session
/// with its own tokio runtime and thread, and a phone that opens twenty at once
/// on a cellular link makes every one of them slower.
pub const MAX_PARALLEL_SERVERS: usize = 4;

/// How long the whole census may take before the remaining servers are
/// reported as unattempted.
///
/// Deliberately not `MAX_PARALLEL_SERVERS × per-server budget`: with more
/// servers than workers the queue is serial, and a user watching a spinner
/// should get a partial answer with the stragglers *named* rather than a
/// complete one eventually.
pub const CENSUS_BUDGET: Duration = Duration::from_secs(25);

/// What happened when this device asked one server.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum ProbeOutcome {
    Listed {
        sessions: Vec<DiscoveredSession>,
        /// 강제 명령이 실제로 적용됐는지, 게이트웨이가 관측해 보고한 값.
        ///
        /// 세션이 아니라 **연결**의 사실이라 여기 있다. `None`은 그 필드를
        /// 보내지 않는 예전 게이트웨이라 "모른다"는 뜻이고, 화면은 그것을
        /// `false`로 바꿔 말하지 않는다 — 멀쩡히 고정된 서버를 의심하게 만든다.
        forced_command_applied: Option<bool>,
    },
    /// SSH worked and `hmux` did not run. The fix is the server's `PATH` or its
    /// `authorized_keys` line, not its network.
    NotProvisioned { detail: String },
    /// This device cannot dial the server at all — no key stored, no pinned
    /// fingerprint. The fix is on the phone.
    NotConfigured { code: String, detail: String },
    /// The bytes did not get there, or the far end was not who it claimed.
    Unreachable { code: String, detail: String },
    /// The server answered the handshake and then did not finish.
    TimedOut { seconds: u64 },
    /// The census ran out of time before this server's turn came. Not the same
    /// sentence as "it did not answer", and not the same fix.
    NotAttempted,
}

impl ProbeOutcome {
    /// Sessions this outcome contributes to the merged list. Empty for every
    /// failure, so a caller cannot accidentally treat a failure as an empty
    /// server.
    #[must_use]
    pub fn sessions(&self) -> &[DiscoveredSession] {
        match self {
            Self::Listed { sessions, .. } => sessions,
            _ => &[],
        }
    }

    /// 강제 명령이 실제로 적용됐는지, 이 서버가 관측해 보고한 값.
    ///
    /// 대답하지 못한 서버는 `None`이다 — 물어보지 못한 것과 "적용되지 않았다"는
    /// 다르고, 후자로 말하면 닿지도 못한 서버를 안전하지 않다고 비난하게 된다.
    #[must_use]
    pub fn forced_command_applied(&self) -> Option<bool> {
        match self {
            Self::Listed {
                forced_command_applied,
                ..
            } => *forced_command_applied,
            _ => None,
        }
    }

    /// Whether this server actually answered. The UI needs this to decide
    /// between "no sessions anywhere" and "nothing answered", which are
    /// opposite messages.
    #[must_use]
    pub fn answered(&self) -> bool {
        matches!(self, Self::Listed { .. })
    }
}

/// Classifies a relay failure into what the user should do about it.
///
/// The mapping is the point of this function: `hmux` missing and the network
/// being down are the same "the channel closed" event at the transport layer,
/// and they have nothing in common at the layer a person acts on.
#[must_use]
pub fn classify(error: &RelayError) -> ProbeOutcome {
    match error {
        RelayError::Gateway { detail } => ProbeOutcome::NotProvisioned {
            detail: detail.clone(),
        },
        RelayError::Configuration { code, detail } => ProbeOutcome::NotConfigured {
            code: (*code).to_string(),
            detail: detail.clone(),
        },
        RelayError::TimedOut { after } => ProbeOutcome::TimedOut {
            seconds: after.as_secs(),
        },
        other => ProbeOutcome::Unreachable {
            code: other.code().to_string(),
            detail: other.to_string(),
        },
    }
}

/// A server to ask, named well enough to report on without a second lookup.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CensusTarget {
    pub server_id: String,
    pub server_label: String,
}

/// Exactly one of these per server in the list. Always.
#[derive(Clone, Debug, Serialize)]
pub struct ServerReport {
    pub server_id: String,
    pub server_label: String,
    pub outcome: ProbeOutcome,
}

/// Asks every target, at most `parallelism` at a time, inside `budget`.
///
/// Order of the returned reports matches the order of `targets`, so the UI
/// renders a stable list rather than one that reshuffles by whichever server
/// was quickest this time.
pub fn take_census<P>(
    targets: &[CensusTarget],
    parallelism: usize,
    budget: Duration,
    probe: P,
) -> Vec<ServerReport>
where
    P: Fn(&CensusTarget) -> ProbeOutcome + Sync,
{
    if targets.is_empty() {
        return Vec::new();
    }
    let deadline = Instant::now() + budget;
    let queue: Mutex<VecDeque<usize>> = Mutex::new((0..targets.len()).collect());
    let collected: Mutex<Vec<Option<ProbeOutcome>>> = Mutex::new(vec![None; targets.len()]);

    // `max(1)` because a parallelism of zero would drain nothing and report
    // every server as unattempted — a configuration mistake that would look
    // exactly like a total network outage.
    let workers = parallelism.clamp(1, targets.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let Some(index) = queue.lock().expect("census queue").pop_front() else {
                    return;
                };
                // Checked before starting, not after: a worker that begins a
                // 12-second dial one millisecond before the deadline would
                // hold the whole census open for those 12 seconds.
                let outcome = if Instant::now() >= deadline {
                    ProbeOutcome::NotAttempted
                } else {
                    probe(&targets[index])
                };
                collected.lock().expect("census results")[index] = Some(outcome);
            });
        }
    });

    let mut collected = collected.into_inner().expect("census results");
    targets
        .iter()
        .enumerate()
        .map(|(index, target)| ServerReport {
            server_id: target.server_id.clone(),
            server_label: target.server_label.clone(),
            // `NotAttempted` rather than an `expect`: every worker writes its
            // slot before returning, so this is unreachable today. It stays a
            // total function because the failure it would otherwise produce —
            // a panic on a phone — is far worse than one over-cautious row,
            // and because "a server vanished from the report" is precisely the
            // outcome this module exists to make impossible.
            outcome: collected[index]
                .take()
                .unwrap_or(ProbeOutcome::NotAttempted),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::RemoteSession;
    use hmux_client::ClientError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn targets(count: usize) -> Vec<CensusTarget> {
        (0..count)
            .map(|index| CensusTarget {
                server_id: format!("srv-{index}"),
                server_label: format!("서버 {index}"),
            })
            .collect()
    }

    fn session(id: &str) -> DiscoveredSession {
        RemoteSession {
            host_liveness: None,
            launch_program: None,
            session_id: id.to_string(),
            session_name: None,
            workspace_id: "ws-1".to_string(),
            session_class: Default::default(),
            lifecycle: Default::default(),
            provider_id: "claude".to_string(),
            runner_principal: "kattpish".to_string(),
            runner_instance: "run-1".to_string(),
            channel_epoch: "1".to_string(),
            host_instance_id: "host-1".to_string(),
            terminal_epoch: "term-1".to_string(),
            capabilities: Vec::new(),
        }
        .into()
    }

    #[test]
    fn every_target_produces_exactly_one_report_in_the_order_given() {
        let targets = targets(5);

        let reports = take_census(&targets, 2, Duration::from_secs(5), |target| {
            ProbeOutcome::Listed {
                forced_command_applied: None,
                sessions: vec![session(&target.server_id)],
            }
        });

        assert_eq!(reports.len(), 5);
        assert_eq!(
            reports
                .iter()
                .map(|report| report.server_id.as_str())
                .collect::<Vec<_>>(),
            vec!["srv-0", "srv-1", "srv-2", "srv-3", "srv-4"]
        );
    }

    /// The core requirement. One box that never answers must not remove the
    /// sessions on every other box — and must itself be named, not omitted.
    #[test]
    fn one_wedged_server_does_not_take_the_rest_of_the_list_with_it() {
        let targets = targets(3);

        let reports = take_census(&targets, 3, Duration::from_millis(150), |target| {
            if target.server_id == "srv-1" {
                std::thread::sleep(Duration::from_secs(3));
                return ProbeOutcome::TimedOut { seconds: 3 };
            }
            ProbeOutcome::Listed {
                forced_command_applied: None,
                sessions: vec![session(&target.server_id)],
            }
        });

        assert!(reports[0].outcome.answered());
        assert!(reports[2].outcome.answered());
        assert!(
            matches!(reports[1].outcome, ProbeOutcome::TimedOut { .. }),
            "the wedged server must be named: {:?}",
            reports[1].outcome
        );
    }

    /// A server the scheduler never reached is a different sentence from a
    /// server that did not answer, and the user acts on it differently.
    /// Reporting it at all is the whole point: silence would look like a box
    /// with no sessions.
    #[test]
    fn servers_the_budget_never_reached_are_named_rather_than_dropped() {
        let targets = targets(6);
        let attempts = AtomicUsize::new(0);

        let reports = take_census(&targets, 1, Duration::from_millis(120), |target| {
            attempts.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(80));
            ProbeOutcome::Listed {
                forced_command_applied: None,
                sessions: vec![session(&target.server_id)],
            }
        });

        assert_eq!(reports.len(), 6, "every server must appear");
        assert!(
            attempts.load(Ordering::SeqCst) < 6,
            "the budget should have stopped the queue"
        );
        assert!(
            reports
                .iter()
                .any(|report| matches!(report.outcome, ProbeOutcome::NotAttempted)),
            "{reports:?}"
        );
    }

    /// The bound that keeps a phone from opening one SSH session per server at
    /// once. Without it, a list of twenty servers is twenty simultaneous
    /// handshakes on a cellular link.
    #[test]
    fn no_more_than_the_permitted_number_of_servers_are_dialed_at_once() {
        let targets = targets(8);
        let live = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);

        take_census(&targets, 3, Duration::from_secs(10), |target| {
            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            live.fetch_sub(1, Ordering::SeqCst);
            ProbeOutcome::Listed {
                forced_command_applied: None,
                sessions: vec![session(&target.server_id)],
            }
        });

        assert!(peak.load(Ordering::SeqCst) <= 3, "{peak:?}");
    }

    /// A parallelism of zero would drain nothing and report a total outage.
    #[test]
    fn a_parallelism_of_zero_still_asks_every_server() {
        let targets = targets(2);

        let reports = take_census(&targets, 0, Duration::from_secs(5), |_| {
            ProbeOutcome::Listed {
                forced_command_applied: None,
                sessions: Vec::new(),
            }
        });

        assert!(reports.iter().all(|report| report.outcome.answered()));
    }

    #[test]
    fn an_empty_server_list_is_an_empty_census_not_a_panic() {
        assert!(take_census(&[], 4, Duration::from_secs(1), |_| {
            ProbeOutcome::NotAttempted
        })
        .is_empty());
    }

    /// A box without `hmux` answers with a shell error over a perfectly healthy
    /// SSH session. Calling that a protocol failure sends the user to look at
    /// the network.
    #[test]
    fn a_server_without_hmux_is_not_provisioned_rather_than_a_protocol_failure() {
        let outcome = classify(&RelayError::Gateway {
            detail: "bash: hmux: command not found".to_string(),
        });

        assert!(
            matches!(outcome, ProbeOutcome::NotProvisioned { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn a_missing_key_is_the_phones_problem_not_the_servers() {
        let outcome = classify(&RelayError::Configuration {
            code: "relay_identity_missing",
            detail: "이 서버에 등록된 SSH 개인키가 없습니다".to_string(),
        });

        match outcome {
            ProbeOutcome::NotConfigured { code, .. } => assert_eq!(code, "relay_identity_missing"),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn a_session_level_refusal_is_reported_with_its_own_code() {
        let outcome = classify(&RelayError::Session(ClientError::MissingCapability {
            capability: "terminal_surface_v1",
        }));

        match outcome {
            ProbeOutcome::Unreachable { code, .. } => assert!(!code.is_empty()),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn a_timeout_keeps_its_own_classification() {
        let outcome = classify(&RelayError::TimedOut {
            after: Duration::from_secs(12),
        });

        assert!(
            matches!(outcome, ProbeOutcome::TimedOut { seconds: 12 }),
            "{outcome:?}"
        );
    }

    /// A failed probe must contribute no sessions, so a caller merging the
    /// reports cannot turn a failure into "that server has nothing running".
    #[test]
    fn a_failed_probe_contributes_no_sessions_and_does_not_count_as_answered() {
        let outcome = ProbeOutcome::NotProvisioned {
            detail: "no hmux".to_string(),
        };

        assert!(outcome.sessions().is_empty());
        assert!(!outcome.answered());
    }
}
