use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use hebbian_process_sampler::process_start_time;
use hmux_host::provider_epoch::ProcessSessionCleanupStage;

#[cfg(target_os = "linux")]
use std::fs;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
use std::process::Command;

const MAX_PROCESS_IDS: usize = 1_000_000;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PROCESS_CENSUS_SLACK: usize = 256;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PROCESS_CENSUS_ATTEMPTS: usize = 4;
const FREEZE_ROUNDS: usize = 4;
const REQUIRED_STABLE_SNAPSHOTS: usize = 2;
const REQUIRED_EMPTY_SNAPSHOTS: usize = 2;
const REQUIRED_ABSENT_SESSION_CENSUSES: usize = 2;
const PROCESS_STATE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const FREEZE_VERIFICATION_TIMEOUT: Duration = Duration::from_millis(100);
const KILL_VERIFICATION_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) struct OwnedProcessSession {
    leader: libc::pid_t,
    leader_witness: ProcessGroupWitness,
    host_process_group: libc::pid_t,
    #[cfg(test)]
    signal_override: Option<SignalOverride>,
    #[cfg(test)]
    sigkill_refusal: Option<TestSigkillRefusal>,
}

pub(crate) struct SessionTermination {
    pub(crate) complete: bool,
    pub(crate) failed_stages: BTreeSet<ProcessSessionCleanupStage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessSessionPresence {
    Absent,
    Live,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessGroupWitness {
    process: libc::pid_t,
    start_time: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GroupSignalOutcome {
    Signaled,
    WitnessRetired,
    OwnershipChanged,
}

#[cfg(test)]
type SignalOverride =
    fn(libc::pid_t, ProcessGroupWitness, libc::c_int) -> Option<io::Result<GroupSignalOutcome>>;

#[cfg(test)]
struct TestSigkillRefusal {
    enabled: Arc<AtomicBool>,
    attempts: Arc<AtomicUsize>,
}

#[must_use = "dropping an uncommitted idle freeze resumes the process groups it stopped"]
pub(crate) struct FrozenIdleProcessSession<'a> {
    session: &'a OwnedProcessSession,
    newly_stopped_groups: BTreeMap<libc::pid_t, ProcessGroupWitness>,
    committed: bool,
}

impl FrozenIdleProcessSession<'_> {
    /// Transfers the frozen provider session to the termination path. The
    /// caller must commit only after it has made provider termination durable
    /// to the in-process worker; otherwise dropping the guard is the safe
    /// rollback and resumes every process group this preparation stopped.
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for FrozenIdleProcessSession<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.session.resume_groups(&self.newly_stopped_groups);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SessionMember {
    process: libc::pid_t,
    group: libc::pid_t,
}

struct SessionCensus {
    members: Vec<SessionMember>,
    groups: BTreeMap<libc::pid_t, ProcessGroupWitness>,
    running_groups: BTreeSet<libc::pid_t>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectChildTermination {
    Unproven,
    SignalAccepted,
    WitnessRetired,
}

impl DirectChildTermination {
    fn is_proven(self) -> bool {
        self != Self::Unproven
    }
}

struct KillVerification {
    direct_child: DirectChildTermination,
    descendants_absent: bool,
}

impl OwnedProcessSession {
    pub(crate) fn new(leader: u32) -> io::Result<Self> {
        let leader = libc::pid_t::try_from(leader)
            .map_err(|_| io::Error::other("provider process id is out of range"))?;
        if leader <= 1 {
            return Err(io::Error::other(
                "provider process is not a valid session leader",
            ));
        }
        if process_session(leader)? != leader {
            return Err(io::Error::other(
                "provider process does not own its POSIX session",
            ));
        }
        let leader_witness = process_group_witness(leader)?
            .ok_or_else(|| io::Error::other("provider process generation is unavailable"))?;
        // SAFETY: getpgrp has no arguments and dereferences no memory.
        let host_process_group = unsafe { libc::getpgrp() };
        if host_process_group == leader {
            return Err(io::Error::other(
                "provider session aliases the Hmux Host process group",
            ));
        }
        Ok(Self {
            leader,
            leader_witness,
            host_process_group,
            #[cfg(test)]
            signal_override: None,
            #[cfg(test)]
            sigkill_refusal: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn refuse_sigkill_while(
        &mut self,
        enabled: Arc<AtomicBool>,
        attempts: Arc<AtomicUsize>,
    ) {
        self.sigkill_refusal = Some(TestSigkillRefusal { enabled, attempts });
    }

    pub(crate) fn process_id(&self) -> u32 {
        u32::try_from(self.leader).expect("validated provider process id must fit u32")
    }

    /// Reversibly freezes this provider-owned POSIX session and proves it is
    /// idle at one linearization point.
    ///
    /// `Ok(Some(_))` means two complete, identical censuses observed only the
    /// exact provider leader while every session group was frozen and the
    /// supplied process-start identity still matched. `Ok(None)` means a
    /// descendant was present. Any observation error is returned. Both
    /// preserve paths resume only groups that this call newly stopped.
    pub(crate) fn freeze_for_idle_retirement<F>(
        &self,
        expected_leader_start_time: u64,
        mut process_start_time: F,
    ) -> io::Result<Option<FrozenIdleProcessSession<'_>>>
    where
        F: FnMut(u32) -> Option<u64>,
    {
        let mut newly_stopped_groups = BTreeMap::new();
        let census = match self.freeze_to_stable_census(
            expected_leader_start_time,
            &mut process_start_time,
            &mut newly_stopped_groups,
        ) {
            Ok(census) => census,
            Err(error) => {
                return match self.resume_groups(&newly_stopped_groups) {
                    Ok(()) => Err(error),
                    Err(resume_error) => Err(io::Error::other(format!(
                        "{error}; additionally failed to resume idle-retirement freeze: \
                         {resume_error}"
                    ))),
                };
            }
        };

        if census
            .members
            .iter()
            .any(|member| member.process != self.leader)
        {
            return match self.resume_groups(&newly_stopped_groups) {
                Ok(()) => Ok(None),
                Err(error) => Err(error),
            };
        }

        Ok(Some(FrozenIdleProcessSession {
            session: self,
            newly_stopped_groups,
            committed: false,
        }))
    }

    pub(crate) fn terminate(
        &self,
        foreground_process_group: Option<libc::pid_t>,
    ) -> io::Result<SessionTermination> {
        self.terminate_with_timeouts(
            foreground_process_group,
            FREEZE_VERIFICATION_TIMEOUT,
            KILL_VERIFICATION_TIMEOUT,
        )
    }

    fn terminate_with_timeouts(
        &self,
        foreground_process_group: Option<libc::pid_t>,
        freeze_verification_timeout: Duration,
        kill_verification_timeout: Duration,
    ) -> io::Result<SessionTermination> {
        let mut groups = BTreeMap::new();
        let mut stable_snapshots = 0;
        let mut failed_stages = BTreeSet::new();
        let freeze_deadline =
            Instant::now() + freeze_verification_timeout.saturating_mul(FREEZE_ROUNDS as u32);

        while Instant::now() < freeze_deadline {
            let snapshot = match self.process_groups() {
                Ok(snapshot) => snapshot,
                Err(_) => {
                    failed_stages.insert(ProcessSessionCleanupStage::ProcessGroupCensus);
                    stable_snapshots = 0;
                    thread::sleep(PROCESS_STATE_POLL_INTERVAL);
                    continue;
                }
            };
            let previous_count = groups.len();
            groups.extend(snapshot);
            self.include_live_foreground(&mut groups, foreground_process_group)?;

            for (&group, &witness) in &groups {
                match self.signal_group(group, witness, libc::SIGSTOP) {
                    Ok(GroupSignalOutcome::Signaled) => {}
                    Ok(GroupSignalOutcome::WitnessRetired) => {}
                    Ok(GroupSignalOutcome::OwnershipChanged) | Err(_) => {
                        failed_stages.insert(ProcessSessionCleanupStage::ProcessGroupSignal);
                    }
                }
            }
            let remaining = freeze_deadline.saturating_duration_since(Instant::now());
            let frozen = match self.wait_until_frozen(freeze_verification_timeout.min(remaining)) {
                Ok(frozen) => frozen,
                Err(_) => {
                    failed_stages.insert(ProcessSessionCleanupStage::FreezeVerification);
                    false
                }
            };
            if groups.len() == previous_count && frozen {
                stable_snapshots += 1;
                if stable_snapshots >= REQUIRED_STABLE_SNAPSHOTS {
                    // These consecutive frozen censuses are the authoritative
                    // proof. Earlier transient observation/signal failures in
                    // this same bounded attempt are superseded; persistent
                    // failures cannot reach this state.
                    failed_stages.remove(&ProcessSessionCleanupStage::ProcessGroupCensus);
                    failed_stages.remove(&ProcessSessionCleanupStage::ProcessGroupSignal);
                    failed_stages.remove(&ProcessSessionCleanupStage::FreezeVerification);
                    break;
                }
            } else {
                stable_snapshots = 0;
            }
        }
        if stable_snapshots < REQUIRED_STABLE_SNAPSHOTS {
            failed_stages.insert(ProcessSessionCleanupStage::FreezeVerification);
        }

        // Every known group is stopped, so it cannot fork while the complete
        // session set is terminated. The provider leader remains unreaped and
        // therefore keeps the session identity unavailable for PID reuse.
        // Re-census and re-signal with fresh witnesses until two consecutive
        // complete snapshots prove that no descendants remain.
        let kill_verification = self.kill_until_descendants_exit(
            &mut groups,
            foreground_process_group,
            kill_verification_timeout,
        )?;
        if !kill_verification.direct_child.is_proven() {
            failed_stages.insert(ProcessSessionCleanupStage::ProcessGroupSignal);
        }
        if !kill_verification.descendants_absent {
            failed_stages.insert(ProcessSessionCleanupStage::DescendantDrain);
        }

        Ok(SessionTermination {
            complete: failed_stages.is_empty()
                && stable_snapshots >= REQUIRED_STABLE_SNAPSHOTS
                && kill_verification.direct_child.is_proven()
                && kill_verification.descendants_absent,
            failed_stages,
        })
    }

    fn freeze_to_stable_census<F>(
        &self,
        expected_leader_start_time: u64,
        process_start_time: &mut F,
        newly_stopped_groups: &mut BTreeMap<libc::pid_t, ProcessGroupWitness>,
    ) -> io::Result<SessionCensus>
    where
        F: FnMut(u32) -> Option<u64>,
    {
        self.verify_leader_identity(expected_leader_start_time, process_start_time)?;

        let deadline = Instant::now() + FREEZE_VERIFICATION_TIMEOUT;
        let mut previous_members = None;
        let mut stable_snapshots = 0;
        loop {
            let census = self.strict_session_census()?;
            for group in &census.running_groups {
                let witness = *census
                    .groups
                    .get(group)
                    .ok_or_else(|| io::Error::other("running process group has no witness"))?;
                newly_stopped_groups.entry(*group).or_insert(witness);
                match self.signal_group(*group, witness, libc::SIGSTOP)? {
                    GroupSignalOutcome::Signaled => {}
                    GroupSignalOutcome::WitnessRetired => {
                        newly_stopped_groups.remove(group);
                    }
                    GroupSignalOutcome::OwnershipChanged => {
                        return Err(io::Error::other(
                            "provider process group changed ownership while freezing",
                        ));
                    }
                }
            }

            if census.running_groups.is_empty() {
                if previous_members.as_ref() == Some(&census.members) {
                    stable_snapshots += 1;
                } else {
                    previous_members = Some(census.members.clone());
                    stable_snapshots = 1;
                }
                if stable_snapshots >= REQUIRED_STABLE_SNAPSHOTS {
                    self.verify_leader_identity(expected_leader_start_time, process_start_time)?;
                    return Ok(census);
                }
            } else {
                previous_members = None;
                stable_snapshots = 0;
            }

            if Instant::now() >= deadline {
                return Err(io::Error::other(
                    "provider process session did not reach a stable frozen census",
                ));
            }
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }
    }

    fn verify_leader_identity<F>(
        &self,
        expected_leader_start_time: u64,
        process_start_time: &mut F,
    ) -> io::Result<()>
    where
        F: FnMut(u32) -> Option<u64>,
    {
        let leader = u32::try_from(self.leader)
            .map_err(|_| io::Error::other("provider process id is out of range"))?;
        if process_session(self.leader)? != self.leader
            || process_start_time(leader) != Some(expected_leader_start_time)
        {
            return Err(io::Error::other(
                "provider process start identity does not match",
            ));
        }
        Ok(())
    }

    fn strict_session_census(&self) -> io::Result<SessionCensus> {
        let mut members = Vec::new();
        let mut groups = BTreeMap::new();
        let mut running_groups = BTreeSet::new();

        for process in process_ids()? {
            if !process_belongs_to_session(process, self.leader, process_session)? {
                continue;
            }
            let Some(group) = observable_process_group(process, process_group)? else {
                continue;
            };
            if group <= 1 || group == self.host_process_group {
                return Err(io::Error::other(
                    "provider session contains an invalid or Host-owned process group",
                ));
            }
            let Some(group_witness) = process_group_witness(process)? else {
                continue;
            };
            let stopped = process_is_stopped_or_zombie(process)?;
            members.push(SessionMember { process, group });
            groups
                .entry(group)
                .and_modify(|witness| {
                    if process == group {
                        *witness = group_witness;
                    }
                })
                .or_insert(group_witness);
            if !stopped {
                running_groups.insert(group);
            }
        }
        members.sort_unstable();
        if !members.iter().any(|member| member.process == self.leader) {
            return Err(io::Error::other(
                "complete process census did not contain the provider leader",
            ));
        }

        Ok(SessionCensus {
            members,
            groups,
            running_groups,
        })
    }

    fn resume_groups(
        &self,
        newly_stopped_groups: &BTreeMap<libc::pid_t, ProcessGroupWitness>,
    ) -> io::Result<()> {
        if newly_stopped_groups.is_empty() {
            return Ok(());
        }
        let fresh_groups = self.process_groups()?;
        let mut first_error = None;
        for (&group, &original_witness) in newly_stopped_groups {
            let witness = fresh_groups
                .get(&group)
                .copied()
                .unwrap_or(original_witness);
            match self.signal_group(group, witness, libc::SIGCONT) {
                Ok(GroupSignalOutcome::Signaled | GroupSignalOutcome::WitnessRetired) => {}
                Ok(GroupSignalOutcome::OwnershipChanged) => {
                    first_error.get_or_insert_with(|| {
                        io::Error::other("provider process group changed ownership before resume")
                    });
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn process_groups(&self) -> io::Result<BTreeMap<libc::pid_t, ProcessGroupWitness>> {
        let mut groups = BTreeMap::new();
        for process in process_ids()? {
            if !process_belongs_to_session(process, self.leader, process_session)? {
                continue;
            }
            let Some(group) = observable_process_group(process, process_group)? else {
                continue;
            };
            if group <= 1 || group == self.host_process_group {
                continue;
            }
            let Some(witness) = process_group_witness(process)? else {
                continue;
            };
            groups
                .entry(group)
                .and_modify(|current| {
                    if process == group {
                        *current = witness;
                    }
                })
                .or_insert(witness);
        }
        groups.entry(self.leader).or_insert(self.leader_witness);
        Ok(groups)
    }

    fn session_members(&self) -> io::Result<Vec<libc::pid_t>> {
        let mut members = Vec::new();
        for process in process_ids()? {
            if process_belongs_to_session(process, self.leader, process_session)? {
                members.push(process);
            }
        }
        Ok(members)
    }

    fn wait_until_frozen(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            let members = self.session_members()?;
            let mut frozen = true;
            for process in members {
                if !process_is_stopped_or_zombie(process)? {
                    frozen = false;
                    break;
                }
            }
            if frozen {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }
    }

    fn kill_until_descendants_exit(
        &self,
        groups: &mut BTreeMap<libc::pid_t, ProcessGroupWitness>,
        foreground_process_group: Option<libc::pid_t>,
        timeout: Duration,
    ) -> io::Result<KillVerification> {
        let deadline = Instant::now() + timeout;
        let mut empty_snapshots = 0;
        let mut direct_child = DirectChildTermination::Unproven;
        loop {
            groups.extend(self.process_groups()?);
            self.include_live_foreground(groups, foreground_process_group)?;
            for (&group, &witness) in groups.iter() {
                let outcome = self.signal_group(group, witness, libc::SIGKILL);
                if group == self.leader && !direct_child.is_proven() {
                    direct_child = match outcome {
                        Ok(GroupSignalOutcome::Signaled) => DirectChildTermination::SignalAccepted,
                        Ok(GroupSignalOutcome::WitnessRetired) => {
                            DirectChildTermination::WitnessRetired
                        }
                        Ok(GroupSignalOutcome::OwnershipChanged) | Err(_) => {
                            DirectChildTermination::Unproven
                        }
                    };
                }
            }
            let has_descendants = self
                .session_members()?
                .into_iter()
                .any(|process| process != self.leader);
            if has_descendants {
                empty_snapshots = 0;
            } else {
                empty_snapshots += 1;
                if empty_snapshots >= REQUIRED_EMPTY_SNAPSHOTS && direct_child.is_proven() {
                    return Ok(KillVerification {
                        direct_child,
                        descendants_absent: true,
                    });
                }
            }
            if Instant::now() >= deadline {
                return Ok(KillVerification {
                    direct_child,
                    descendants_absent: empty_snapshots >= REQUIRED_EMPTY_SNAPSHOTS,
                });
            }
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }
    }

    fn include_live_foreground(
        &self,
        groups: &mut BTreeMap<libc::pid_t, ProcessGroupWitness>,
        foreground_process_group: Option<libc::pid_t>,
    ) -> io::Result<()> {
        let Some(group) = foreground_process_group.filter(|group| *group > 1) else {
            return Ok(());
        };
        if group == self.host_process_group {
            return Ok(());
        }
        match process_session(group) {
            Ok(session) if session == self.leader => {}
            Ok(_) => return Ok(()),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(()),
            Err(error) => return Err(error),
        }
        match process_group(group) {
            Ok(current) if current == group => {}
            Ok(_) => return Ok(()),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(()),
            Err(error) => return Err(error),
        }
        if let Some(witness) = process_group_witness(group)? {
            groups.entry(group).or_insert(witness);
            return Ok(());
        }
        Ok(())
    }

    fn signal_group(
        &self,
        group: libc::pid_t,
        witness: ProcessGroupWitness,
        signal: libc::c_int,
    ) -> io::Result<GroupSignalOutcome> {
        if group <= 1 || group == self.host_process_group {
            return Err(io::Error::other(
                "refusing to signal an invalid or Host-owned process group",
            ));
        }
        let current_session = match process_session(witness.process) {
            Ok(session) => Some(session),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => None,
            Err(error) => return Err(error),
        };
        let current_group = match process_group(witness.process) {
            Ok(group) => Some(group),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => None,
            Err(error) => return Err(error),
        };
        let current_start_time =
            observable_process_start_time(witness.process, process_start_time, process_session)?;
        let exact_generation = current_start_time == Some(witness.start_time);
        if !exact_generation {
            return Ok(GroupSignalOutcome::WitnessRetired);
        }
        if current_session != Some(self.leader) || current_group != Some(group) {
            return Ok(GroupSignalOutcome::OwnershipChanged);
        }
        #[cfg(test)]
        if signal == libc::SIGKILL {
            if let Some(fault) = &self.sigkill_refusal {
                fault.attempts.fetch_add(1, Ordering::Relaxed);
                if fault.enabled.load(Ordering::Acquire) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "fault-injected SIGKILL refusal",
                    ));
                }
            }
        }
        #[cfg(test)]
        if let Some(result) = self
            .signal_override
            .and_then(|override_signal| override_signal(group, witness, signal))
        {
            return result;
        }
        // SAFETY: ownership was revalidated immediately above. A negative PID
        // addresses exactly the provider-session process group.
        if unsafe { libc::kill(-group, signal) } == 0 {
            return Ok(GroupSignalOutcome::Signaled);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(GroupSignalOutcome::Signaled);
        }
        Err(error)
    }
}

/// Performs two fresh, complete process-table censuses for one numeric POSIX
/// session id. This is valid only after the caller has separately proved the
/// exact session-leader generation absent. Any member in either census is
/// live; any observation other than ESRCH is an error, never absence.
pub(crate) fn observe_process_session_presence(
    session_leader: u32,
) -> io::Result<ProcessSessionPresence> {
    let session_leader = libc::pid_t::try_from(session_leader)
        .map_err(|_| io::Error::other("provider session id is out of range"))?;
    observe_process_session_presence_with(session_leader, process_ids, process_session)
}

fn observe_process_session_presence_with(
    session_leader: libc::pid_t,
    mut census: impl FnMut() -> io::Result<Vec<libc::pid_t>>,
    mut session_of: impl FnMut(libc::pid_t) -> io::Result<libc::pid_t>,
) -> io::Result<ProcessSessionPresence> {
    if session_leader <= 1 {
        return Err(io::Error::other("provider session id is invalid"));
    }
    for _ in 0..REQUIRED_ABSENT_SESSION_CENSUSES {
        for process in census()? {
            if process <= 1 {
                continue;
            }
            match session_of(process) {
                Ok(session) if session == session_leader => {
                    return Ok(ProcessSessionPresence::Live);
                }
                Ok(_) => {}
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(ProcessSessionPresence::Absent)
}

fn process_belongs_to_session(
    process: libc::pid_t,
    leader: libc::pid_t,
    session_of: impl FnOnce(libc::pid_t) -> io::Result<libc::pid_t>,
) -> io::Result<bool> {
    if process <= 1 {
        return Ok(false);
    }
    match session_of(process) {
        Ok(session) => Ok(session == leader),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

fn observable_process_group(
    process: libc::pid_t,
    group_of: impl FnOnce(libc::pid_t) -> io::Result<libc::pid_t>,
) -> io::Result<Option<libc::pid_t>> {
    match group_of(process) {
        Ok(group) => Ok(Some(group)),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

fn observable_process_start_time(
    process: libc::pid_t,
    start_time_of: impl FnOnce(u32) -> Option<u64>,
    session_of: impl FnOnce(libc::pid_t) -> io::Result<libc::pid_t>,
) -> io::Result<Option<u64>> {
    let process_id = u32::try_from(process)
        .map_err(|_| io::Error::other("provider process id is out of range"))?;
    if let Some(start_time) = start_time_of(process_id) {
        return Ok(Some(start_time));
    }
    match session_of(process) {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::other(
            "provider process generation could not be observed",
        )),
    }
}

fn process_group_witness(process: libc::pid_t) -> io::Result<Option<ProcessGroupWitness>> {
    Ok(
        observable_process_start_time(process, process_start_time, process_session)?.map(
            |start_time| ProcessGroupWitness {
                process,
                start_time,
            },
        ),
    )
}

fn process_session(process: libc::pid_t) -> io::Result<libc::pid_t> {
    // SAFETY: getsid reads kernel process metadata and dereferences no memory.
    let session = unsafe { libc::getsid(process) };
    if session >= 0 {
        Ok(session)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn process_group(process: libc::pid_t) -> io::Result<libc::pid_t> {
    // SAFETY: getpgid reads kernel process metadata and dereferences no memory.
    let group = unsafe { libc::getpgid(process) };
    if group >= 0 {
        Ok(group)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn process_is_stopped_or_zombie(process: libc::pid_t) -> io::Result<bool> {
    let stat = match fs::read_to_string(format!("/proc/{process}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let state = stat
        .rfind(')')
        .and_then(|end| stat.get(end + 1..))
        .and_then(|suffix| suffix.split_whitespace().next())
        .and_then(|value| value.as_bytes().first())
        .copied()
        .ok_or_else(|| io::Error::other("process stat has no state"))?;
    Ok(matches!(state, b'T' | b't' | b'Z'))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn process_is_stopped_or_zombie(process: libc::pid_t) -> io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>())
        .map_err(|_| io::Error::other("process info buffer is too large"))?;
    // SAFETY: info points to an initialized writable buffer of `expected`
    // bytes, and proc_pidinfo writes a proc_bsdinfo for the requested process.
    let actual = unsafe {
        libc::proc_pidinfo(
            process,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if actual == expected {
        // SAFETY: proc_pidinfo initialized the complete structure above.
        let info = unsafe { info.assume_init() };
        return Ok(matches!(info.pbi_status, libc::SSTOP | libc::SZOMB));
    }
    match process_session(process) {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::other("process state inspection was incomplete")),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
fn process_is_stopped_or_zombie(process: libc::pid_t) -> io::Result<bool> {
    let output = Command::new("/bin/ps")
        .args(["-o", "state=", "-p", &process.to_string()])
        .output()?;
    if !output.status.success() {
        return match process_session(process) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
            Err(error) => Err(error),
            Ok(_) => Err(io::Error::other("process state inspection failed")),
        };
    }
    let state = output
        .stdout
        .into_iter()
        .find(|byte| !byte.is_ascii_whitespace());
    Ok(matches!(state, None | Some(b'T' | b't' | b'Z')))
}

#[cfg(target_os = "linux")]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    let mut processes = Vec::new();
    for (index, entry) in fs::read_dir("/proc")?.enumerate() {
        if index >= MAX_PROCESS_IDS {
            return Err(io::Error::other("process census exceeded its safety bound"));
        }
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Ok(process) = name.parse::<libc::pid_t>() {
            processes.push(process);
        }
    }
    Ok(processes)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    // SAFETY: a null buffer asks libproc for the current PID count.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(io::Error::last_os_error());
    }
    let mut capacity = usize::try_from(count)
        .unwrap_or(MAX_PROCESS_IDS)
        .saturating_add(PROCESS_CENSUS_SLACK)
        .min(MAX_PROCESS_IDS);
    for _ in 0..PROCESS_CENSUS_ATTEMPTS {
        let mut processes = vec![0; capacity];
        let byte_len = processes
            .len()
            .checked_mul(std::mem::size_of::<libc::pid_t>())
            .and_then(|value| libc::c_int::try_from(value).ok())
            .ok_or_else(|| io::Error::other("process list buffer is too large"))?;
        // SAFETY: the buffer is writable for byte_len bytes and contains pid_t
        // entries as required by proc_listallpids.
        let actual = unsafe { libc::proc_listallpids(processes.as_mut_ptr().cast(), byte_len) };
        if actual < 0 {
            return Err(io::Error::last_os_error());
        }
        let actual = usize::try_from(actual)
            .map_err(|_| io::Error::other("process census count is out of range"))?;
        if actual < capacity {
            processes.truncate(actual);
            return Ok(processes);
        }
        if capacity == MAX_PROCESS_IDS {
            break;
        }
        capacity = capacity.saturating_mul(2).min(MAX_PROCESS_IDS);
    }
    Err(io::Error::other(
        "process census remained truncated after bounded retries",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    let output = Command::new("/bin/ps").args(["-axo", "pid="]).output()?;
    if !output.status.success() || output.stdout.len() > 8 * 1024 * 1024 {
        return Err(io::Error::other("process table sampling failed"));
    }
    let output = std::str::from_utf8(&output.stdout)
        .map_err(|_| io::Error::other("process table output is not UTF-8"))?;
    let mut processes = Vec::new();
    for value in output.split_whitespace() {
        if processes.len() >= MAX_PROCESS_IDS {
            return Err(io::Error::other("process census exceeded its safety bound"));
        }
        processes.push(
            value
                .parse()
                .map_err(|_| io::Error::other("process table contains an invalid process id"))?,
        );
    }
    Ok(processes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Stdio};

    struct TestProvider {
        child: Child,
        leader: libc::pid_t,
    }

    impl TestProvider {
        fn idle() -> Self {
            let mut command = std::process::Command::new("/bin/sleep");
            command.arg("30");
            Self::spawn(command)
        }

        fn with_descendant() -> (Self, libc::pid_t) {
            let mut command = std::process::Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "set -m; sleep 30 & child=$!; echo \"$child\"; wait \"$child\"",
                ])
                .stdout(Stdio::piped());
            let mut child = Self::spawn_child(command);
            let mut line = String::new();
            BufReader::new(
                child
                    .stdout
                    .take()
                    .expect("descendant fixture must expose stdout"),
            )
            .read_line(&mut line)
            .expect("descendant fixture must report its child");
            let descendant = line
                .trim()
                .parse()
                .expect("descendant fixture must report a process id");
            let leader = libc::pid_t::try_from(child.id()).expect("test process id must fit");
            (Self { child, leader }, descendant)
        }

        fn with_group_churn() -> Self {
            let mut command = std::process::Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "set -m; trap '' HUP TERM; while :; do (sleep 0.01) & wait $!; done",
                ])
                .stderr(Stdio::null());
            Self::spawn(command)
        }

        fn spawn(command: std::process::Command) -> Self {
            let child = Self::spawn_child(command);
            let leader = libc::pid_t::try_from(child.id()).expect("test process id must fit");
            Self { child, leader }
        }

        fn spawn_child(mut command: std::process::Command) -> Child {
            // SAFETY: pre_exec performs only the async-signal-safe setsid
            // syscall before the test child executes its target program.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            command.spawn().expect("test provider must spawn")
        }

        fn session(&self) -> OwnedProcessSession {
            OwnedProcessSession::new(self.child.id()).expect("test provider must own its session")
        }
    }

    impl Drop for TestProvider {
        fn drop(&mut self) {
            if let Ok(session) = OwnedProcessSession::new(self.child.id()) {
                let _ = session.terminate(None);
            }
            // SAFETY: the direct child remains unreaped, so its positive
            // session/process-group identity cannot be reused during cleanup.
            unsafe {
                libc::kill(-self.leader, libc::SIGCONT);
                libc::kill(-self.leader, libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }

    fn wait_for_stopped(process: libc::pid_t, expected: bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if process_is_stopped_or_zombie(process).ok() == Some(expected) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "process {process} did not reach stopped={expected}"
            );
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }
    }

    #[test]
    fn dropping_idle_freeze_resumes_newly_stopped_leader() {
        let provider = TestProvider::idle();
        let session = provider.session();

        let guard = session
            .freeze_for_idle_retirement(41, |_| Some(41))
            .expect("idle census must complete")
            .expect("leader-only session must freeze");
        wait_for_stopped(provider.leader, true);
        drop(guard);

        wait_for_stopped(provider.leader, false);
    }

    #[test]
    fn committed_idle_freeze_keeps_leader_stopped_for_termination() {
        let provider = TestProvider::idle();
        let session = provider.session();

        let guard = session
            .freeze_for_idle_retirement(42, |_| Some(42))
            .expect("idle census must complete")
            .expect("leader-only session must freeze");
        guard.commit();

        wait_for_stopped(provider.leader, true);
    }

    #[test]
    fn descendant_preserves_session_and_resumes_newly_stopped_groups() {
        let (provider, descendant) = TestProvider::with_descendant();
        let session = provider.session();
        assert_eq!(
            process_session(descendant).expect("descendant session must be inspectable"),
            provider.leader
        );
        assert_eq!(
            process_group(descendant).expect("descendant group must be inspectable"),
            descendant
        );

        let guard = session
            .freeze_for_idle_retirement(43, |_| Some(43))
            .expect("busy census must complete");

        assert!(guard.is_none(), "a descendant must prevent idle retirement");
        wait_for_stopped(provider.leader, false);
        wait_for_stopped(descendant, false);
    }

    #[test]
    fn changed_start_identity_fails_closed_and_resumes_provider() {
        let provider = TestProvider::idle();
        let session = provider.session();
        let calls = Cell::new(0);

        let result = session.freeze_for_idle_retirement(44, |_| {
            let call = calls.get();
            calls.set(call + 1);
            Some(if call == 0 { 44 } else { 45 })
        });
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("changed process identity must fail closed"),
        };

        assert!(error.to_string().contains("start identity"));
        wait_for_stopped(provider.leader, false);
    }

    #[test]
    fn dropping_guard_does_not_resume_a_previously_stopped_group() {
        let provider = TestProvider::idle();
        let session = provider.session();
        assert_eq!(
            // SAFETY: the direct child is a verified provider-session group
            // leader and remains unreaped for the lifetime of the fixture.
            unsafe { libc::kill(-provider.leader, libc::SIGSTOP) },
            0
        );
        wait_for_stopped(provider.leader, true);

        let guard = session
            .freeze_for_idle_retirement(46, |_| Some(46))
            .expect("pre-frozen idle census must complete")
            .expect("leader-only session must freeze");
        drop(guard);

        thread::sleep(Duration::from_millis(50));
        assert!(matches!(
            process_is_stopped_or_zombie(provider.leader),
            Ok(true)
        ));
    }

    #[test]
    fn retired_exact_witness_does_not_make_cleanup_incomplete() {
        let (provider, descendant) = TestProvider::with_descendant();
        let session = provider.session();
        let group = process_group(descendant).expect("descendant group must be inspectable");
        let witness = process_group_witness(descendant)
            .expect("descendant generation observation must complete")
            .expect("live descendant generation must be inspectable");

        // SAFETY: the fixture owns this exact descendant process group and its
        // provider leader remains unreaped, so the group id cannot alias the
        // Hmux test runner while the signal is sent.
        assert_eq!(unsafe { libc::kill(-group, libc::SIGKILL) }, 0);
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_start_time(u32::try_from(descendant).unwrap()) == Some(witness.start_time) {
            assert!(
                Instant::now() < deadline,
                "descendant generation did not retire"
            );
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }

        assert_eq!(
            session
                .signal_group(group, witness, libc::SIGSTOP)
                .expect("retired witness classification must not fail"),
            GroupSignalOutcome::WitnessRetired
        );
    }

    #[test]
    fn surviving_orphan_fault_injection_remains_fail_closed() {
        fn refuse_sigkill(
            _group: libc::pid_t,
            _witness: ProcessGroupWitness,
            signal: libc::c_int,
        ) -> Option<io::Result<GroupSignalOutcome>> {
            (signal == libc::SIGKILL).then(|| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fault-injected SIGKILL refusal",
                ))
            })
        }

        let (provider, descendant) = TestProvider::with_descendant();
        let descendant_start_time = process_group_witness(descendant)
            .expect("descendant generation observation must complete")
            .expect("live descendant generation must be inspectable")
            .start_time;
        let mut session = provider.session();
        session.signal_override = Some(refuse_sigkill);
        let termination = session
            .terminate_with_timeouts(None, FREEZE_VERIFICATION_TIMEOUT, Duration::ZERO)
            .expect("termination remains a typed proof result");

        assert!(!termination.complete);
        assert!(
            termination
                .failed_stages
                .contains(&ProcessSessionCleanupStage::DescendantDrain)
        );
        assert_eq!(
            process_start_time(u32::try_from(descendant).unwrap()),
            Some(descendant_start_time),
            "fault injection must leave the exact descendant generation alive"
        );
    }

    #[test]
    fn process_census_observation_errors_never_become_absence() {
        let leader = 41;
        let process = 42;

        for error_code in [libc::EPERM, libc::EIO] {
            let session_error = process_belongs_to_session(process, leader, |_| {
                Err(io::Error::from_raw_os_error(error_code))
            })
            .expect_err("a non-ESRCH session observation must stay ambiguous");
            assert_eq!(session_error.raw_os_error(), Some(error_code));

            let group_error = observable_process_group(process, |_| {
                Err(io::Error::from_raw_os_error(error_code))
            })
            .expect_err("a non-ESRCH process-group observation must stay ambiguous");
            assert_eq!(group_error.raw_os_error(), Some(error_code));

            let start_error = observable_process_start_time(
                process,
                |_| None,
                |_| Err(io::Error::from_raw_os_error(error_code)),
            )
            .expect_err("an unavailable generation with an ambiguous session must fail closed");
            assert_eq!(start_error.raw_os_error(), Some(error_code));
        }

        assert!(
            !process_belongs_to_session(process, leader, |_| {
                Err(io::Error::from_raw_os_error(libc::ESRCH))
            })
            .expect("ESRCH is exact process absence")
        );
        assert_eq!(
            observable_process_group(process, |_| {
                Err(io::Error::from_raw_os_error(libc::ESRCH))
            })
            .expect("ESRCH is exact process absence"),
            None
        );
        assert_eq!(
            observable_process_start_time(
                process,
                |_| None,
                |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
            )
            .expect("ESRCH is exact process absence"),
            None
        );

        let live_without_generation =
            observable_process_start_time(process, |_| None, |_| Ok(leader))
                .expect_err("a live process with incomplete generation metadata must fail closed");
        assert!(
            live_without_generation
                .to_string()
                .contains("generation could not be observed")
        );
    }

    #[test]
    fn process_session_absence_requires_two_complete_strict_censuses() {
        let session_leader = 41;
        let census_calls = Cell::new(0);
        let presence = observe_process_session_presence_with(
            session_leader,
            || {
                let call = census_calls.get();
                census_calls.set(call + 1);
                Ok(vec![if call == 0 { 51 } else { 52 }])
            },
            |process| Ok(if process == 52 { session_leader } else { 7 }),
        )
        .expect("both complete censuses must be observable");
        assert_eq!(presence, ProcessSessionPresence::Live);
        assert_eq!(census_calls.get(), 2);

        let census_calls = Cell::new(0);
        let presence = observe_process_session_presence_with(
            session_leader,
            || {
                census_calls.set(census_calls.get() + 1);
                Ok(vec![51])
            },
            |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
        )
        .expect("ESRCH members are exact absence");
        assert_eq!(presence, ProcessSessionPresence::Absent);
        assert_eq!(census_calls.get(), 2);

        let census_calls = Cell::new(0);
        let census_error = observe_process_session_presence_with(
            session_leader,
            || {
                let call = census_calls.get();
                census_calls.set(call + 1);
                if call == 0 {
                    Ok(Vec::new())
                } else {
                    Err(io::Error::other("fault-injected truncated census"))
                }
            },
            |_| Ok(7),
        )
        .expect_err("an incomplete second census must fail closed");
        assert!(census_error.to_string().contains("truncated census"));
        assert_eq!(census_calls.get(), 2);

        for error_code in [libc::EPERM, libc::EIO] {
            let observation_error = observe_process_session_presence_with(
                session_leader,
                || Ok(vec![51]),
                |_| Err(io::Error::from_raw_os_error(error_code)),
            )
            .expect_err("non-ESRCH getsid failure must stay unknown");
            assert_eq!(observation_error.raw_os_error(), Some(error_code));
        }
    }

    #[test]
    fn concurrent_short_lived_process_groups_terminate_with_complete_proof() {
        // The shared process sampler has four workers. This direct-census
        // stress intentionally exceeds that bound so a cached sampler witness
        // can never become an accidental authority for destructive cleanup.
        const CALLERS: usize = 8;
        // Build every process fixture before any worker waits. If fixture
        // creation fails under process pressure, no partially filled barrier
        // can strand the already-created workers and hang the test binary.
        let providers = (0..CALLERS)
            .map(|_| TestProvider::with_group_churn())
            .collect::<Vec<_>>();
        let workers = providers
            .into_iter()
            .map(|provider| {
                let (start_tx, start_rx) = std::sync::mpsc::sync_channel(1);
                let worker = thread::spawn(move || {
                    if start_rx.recv().is_err() {
                        return;
                    }
                    let termination = provider
                        .session()
                        .terminate(None)
                        .expect("direct process-session termination must be observable");
                    assert!(
                        termination.complete,
                        "short-lived group churn left incomplete stages: {:?}",
                        termination.failed_stages
                    );
                });
                (start_tx, worker)
            })
            .collect::<Vec<_>>();

        for (start, _) in &workers {
            start.send(()).expect("termination stress worker exited");
        }
        for (_, worker) in workers {
            worker.join().expect("termination stress worker panicked");
        }
    }
}
