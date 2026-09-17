use hebbian_process_sampler::ProcessSnapshot;
use hmux_host::local_protocol::SessionRetirementReceiptReason;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IdleRetirementDecision {
    Eligible,
    Preserve(SessionRetirementReceiptReason),
}

pub(crate) struct IdleRetirementInput<'a> {
    /// A configured lifetime policy or an explicit manual sweep authorizes
    /// evaluation. Ordinary detach/EOF never reaches this function.
    pub(crate) authorized: bool,
    pub(crate) other_attachments: usize,
    pub(crate) provider_exited: bool,
    pub(crate) provider_pid: u32,
    pub(crate) provider_identity_matches: bool,
    pub(crate) expected_program: &'a str,
    pub(crate) snapshot: Option<&'a ProcessSnapshot>,
}

/// Decide only from one complete Host-local observation.
///
/// OS sampling errors are represented as `None` and preserve the session. The
/// caller still performs a reversible process-session freeze before committing
/// termination, because no userspace snapshot can close the final fork race.
pub(crate) fn evaluate_idle_retirement(input: IdleRetirementInput<'_>) -> IdleRetirementDecision {
    if !input.authorized {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::PolicyNotConfigured,
        );
    }
    if input.other_attachments != 0 {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::OtherClientsAttached,
        );
    }
    if input.provider_exited {
        return IdleRetirementDecision::Preserve(SessionRetirementReceiptReason::SessionExited);
    }
    if !input.provider_identity_matches {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::ProviderIdentityChanged,
        );
    }
    let Some(snapshot) = input.snapshot else {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::ProcessObservationUnavailable,
        );
    };
    let Some(provider) = snapshot
        .processes
        .iter()
        .find(|process| process.pid == input.provider_pid)
    else {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::ProviderIdentityChanged,
        );
    };
    let observed_program = provider
        .command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_start_matches('-');
    let expected_program = input
        .expected_program
        .rsplit('/')
        .next()
        .unwrap_or(input.expected_program)
        .trim_start_matches('-');
    if provider.session_id != input.provider_pid || observed_program != expected_program {
        return IdleRetirementDecision::Preserve(
            SessionRetirementReceiptReason::ProviderIdentityChanged,
        );
    }
    if snapshot.processes.iter().any(|process| {
        process.pid != input.provider_pid && process.session_id == input.provider_pid
    }) {
        return IdleRetirementDecision::Preserve(SessionRetirementReceiptReason::ProviderBusy);
    }
    IdleRetirementDecision::Eligible
}

#[cfg(test)]
mod tests {
    use super::*;
    use hebbian_process_sampler::ProcessRecord;

    fn snapshot(processes: Vec<ProcessRecord>) -> ProcessSnapshot {
        ProcessSnapshot {
            revision: 1,
            processes,
        }
    }

    fn process(pid: u32, parent_pid: u32, session_id: u32, command: &str) -> ProcessRecord {
        ProcessRecord {
            pid,
            parent_pid,
            session_id,
            command: command.into(),
        }
    }

    fn input(snapshot: Option<&ProcessSnapshot>) -> IdleRetirementInput<'_> {
        IdleRetirementInput {
            authorized: true,
            other_attachments: 0,
            provider_exited: false,
            provider_pid: 42,
            provider_identity_matches: true,
            expected_program: "/bin/zsh",
            snapshot,
        }
    }

    #[test]
    fn only_the_original_shell_is_eligible() {
        let census = snapshot(vec![process(42, 1, 42, "-zsh")]);
        assert_eq!(
            evaluate_idle_retirement(input(Some(&census))),
            IdleRetirementDecision::Eligible
        );
    }

    #[test]
    fn background_and_stopped_jobs_are_blocking_session_members() {
        let census = snapshot(vec![process(42, 1, 42, "zsh"), process(84, 42, 42, "pnpm")]);
        assert_eq!(
            evaluate_idle_retirement(input(Some(&census))),
            IdleRetirementDecision::Preserve(SessionRetirementReceiptReason::ProviderBusy)
        );
    }

    #[test]
    fn another_attachment_wins_before_process_observation() {
        let mut candidate = input(None);
        candidate.other_attachments = 1;
        assert_eq!(
            evaluate_idle_retirement(candidate),
            IdleRetirementDecision::Preserve(SessionRetirementReceiptReason::OtherClientsAttached)
        );
    }

    #[test]
    fn unavailable_or_changed_process_evidence_preserves() {
        assert_eq!(
            evaluate_idle_retirement(input(None)),
            IdleRetirementDecision::Preserve(
                SessionRetirementReceiptReason::ProcessObservationUnavailable
            )
        );
        let census = snapshot(vec![process(42, 1, 42, "sleep")]);
        assert_eq!(
            evaluate_idle_retirement(input(Some(&census))),
            IdleRetirementDecision::Preserve(
                SessionRetirementReceiptReason::ProviderIdentityChanged
            )
        );
    }
}
