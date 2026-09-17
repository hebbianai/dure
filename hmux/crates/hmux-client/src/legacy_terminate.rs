use crate::{ClientError, ProcessDescriptor, SessionDescriptor};
use hmux_local_platform::peer_attestation::ColocatedSameUserPeer;
#[cfg(not(target_os = "macos"))]
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;
use std::thread;
use std::time::{Duration, Instant};

mod platform;
#[cfg(not(target_os = "macos"))]
use platform::process_group;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use platform::signal_process_generation;
use platform::{
    observe_process, parse_platform_start_marker, preflight_process_generation, process_ids,
    process_is_stopped, process_is_stopped_or_zombie, process_is_zombie, process_session,
    verify_host_executable,
};
#[cfg(target_os = "macos")]
use platform::{process_unique_generation_is_current, process_unique_identity};

const PROCESS_START_TOLERANCE: Duration = Duration::from_secs(2);
const FREEZE_ROUNDS: usize = 4;
const REQUIRED_STABLE_SNAPSHOTS: usize = 2;
const PROCESS_STATE_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(not(target_os = "macos"))]
const FREEZE_VERIFICATION_TIMEOUT: Duration = Duration::from_millis(100);
const THAW_VERIFICATION_TIMEOUT: Duration = Duration::from_millis(250);
const KILL_VERIFICATION_TIMEOUT: Duration = Duration::from_secs(1);
const REQUIRED_EMPTY_SNAPSHOTS: usize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessObservation {
    process_id: u32,
    parent_process_id: u32,
    process_group_id: u32,
    process_session_id: u32,
    start_unix_ms: u64,
    platform_start_identity: PlatformStartIdentity,
}

/// Empty on a platform with no process adapter, and deliberately so. The only
/// producers are `observe_process` and `parse_platform_start_marker`, both of
/// which give up there, so a placeholder variant would be a value nothing can
/// ever hold — and the compiler says as much.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlatformStartIdentity {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    MacOs {
        unique_id: u64,
        id_version: i32,
        seconds: u64,
        microseconds: u32,
    },
    #[cfg(target_os = "linux")]
    Linux { boot_id: u128, ticks: u64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessStartMarker {
    SpawnedAfter {
        process_id: u32,
        unix_ms: u64,
    },
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    MacOsUnique {
        unique_id: u64,
        seconds: u64,
        microseconds: u32,
    },
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    MacOsUniqueV2 {
        unique_id: u64,
        id_version: i32,
        seconds: u64,
        microseconds: u32,
    },
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    MacOsLegacy {
        seconds: u64,
        microseconds: u32,
    },
    #[cfg(target_os = "linux")]
    PlatformExact(PlatformStartIdentity),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(target_os = "macos", target_os = "ios"))]
enum ProcessGenerationPreflight {
    Current,
    Absent,
    ExitInProgress,
}
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
type ProcessGenerationPreflight = std::convert::Infallible;

/// Captures the exact OS generation of one local process for durable
/// discovery. Unlike the legacy `pid-unix_ms` marker, this identity does not
/// depend on how long process startup took before the descriptor was written.
pub fn exact_local_process_generation(process_id: u32) -> Result<ProcessDescriptor, ClientError> {
    checked_process_id(process_id)?;
    let observed =
        observe_process(process_id).map_err(|reason| verification_refused("process", reason))?;
    if observed.process_id != process_id {
        return Err(verification_refused(
            "process",
            io::Error::other("observed process id changed"),
        ));
    }
    Ok(ProcessDescriptor {
        process_id,
        start_marker: platform_start_marker(observed.platform_start_identity),
    })
}

fn platform_start_marker(identity: PlatformStartIdentity) -> String {
    match identity {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        PlatformStartIdentity::MacOs {
            unique_id,
            seconds,
            microseconds,
            ..
        } => format!("macos-proc-unique-v3:{unique_id}:{seconds}:{microseconds}"),
        #[cfg(target_os = "linux")]
        PlatformStartIdentity::Linux { boot_id, ticks } => {
            format!("linux-proc-start-v2:{boot_id:032x}:{ticks}")
        }
    }
}

/// Signals the session's process group.
///
/// Takes a colocation witness **by argument** because pids only mean anything
/// on the kernel that issued them. This function reads the local process table
/// with ids that came from a manifest; if that manifest could ever describe
/// another machine, the ids would name unrelated local processes and the kill
/// would land on them. Requiring the witness makes that a compile error at
/// every call site rather than a silent wrong answer once a relay exists.
pub(crate) fn terminate_verified_process_session(
    _colocation: &ColocatedSameUserPeer,
    descriptor: &SessionDescriptor,
) -> Result<(), ClientError> {
    if process_generation_is_absent(&descriptor.provider_process)? {
        return Ok(());
    }
    VerifiedStandaloneProcesses::inspect(descriptor)?.terminate()
}

/// Signals the Host process. Same reasoning as
/// [`terminate_verified_process_session`].
pub(crate) fn terminate_verified_host(
    _colocation: &ColocatedSameUserPeer,
    descriptor: &SessionDescriptor,
) -> Result<(), ClientError> {
    require_provider_terminated(&descriptor.provider_process)?;
    if process_generation_is_absent(&descriptor.host_process)? {
        return Ok(());
    }
    let host = observe_process(descriptor.host_process.process_id)
        .and_then(|observed| verify_process(&descriptor.host_process, observed))
        .map_err(|reason| verification_refused("Host", reason))?;
    if host.process_group_id != host.process_id || host.process_session_id != host.process_id {
        return Err(verification_refused(
            "Host",
            io::Error::other("Host no longer owns its process group and POSIX session"),
        ));
    }
    verify_host_executable(host.process_id)?;

    let host_process = checked_process_id(host.process_id)?;
    // SAFETY: getpgrp has no arguments and dereferences no memory.
    let caller_group = unsafe { libc::getpgrp() };
    if host_process == caller_group {
        return Err(verification_refused(
            "Host",
            io::Error::other("Host process group aliases the caller"),
        ));
    }
    signal_verified_host(
        &descriptor.host_process,
        caller_group,
        host_process,
        libc::SIGTERM,
    )?;
    if wait_until_process_exited(&descriptor.host_process, Duration::from_millis(500))? {
        return Ok(());
    }
    signal_verified_host(
        &descriptor.host_process,
        caller_group,
        host_process,
        libc::SIGKILL,
    )?;
    if wait_until_process_exited(&descriptor.host_process, Duration::from_secs(1))? {
        return Ok(());
    }
    Err(ClientError::transport(
        "hmux_legacy_termination_incomplete",
        "legacy Hmux Host remained alive after verified termination",
    ))
}

struct VerifiedStandaloneProcesses {
    host: ProcessDescriptor,
    provider: ProcessDescriptor,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct MacProcessGeneration {
    process_id: u32,
    unique_id: u64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MacProcessLineage {
    generation: MacProcessGeneration,
    parent_unique_id: u64,
}

impl VerifiedStandaloneProcesses {
    fn inspect(descriptor: &SessionDescriptor) -> Result<Self, ClientError> {
        let host = observe_process(descriptor.host_process.process_id)
            .and_then(|observed| verify_process(&descriptor.host_process, observed))
            .map_err(|reason| verification_refused("Host", reason))?;
        let provider = observe_process(descriptor.provider_process.process_id)
            .and_then(|observed| verify_process(&descriptor.provider_process, observed))
            .map_err(|reason| verification_refused("provider", reason))?;

        verify_process_tree(host, provider)?;
        if provider.process_session_id == current_process_session()? {
            return Err(verification_refused(
                "provider",
                io::Error::other("provider POSIX session aliases the caller"),
            ));
        }
        verify_host_executable(host.process_id)?;

        Ok(Self {
            host: descriptor.host_process.clone(),
            provider: descriptor.provider_process.clone(),
        })
    }

    fn terminate(&self) -> Result<(), ClientError> {
        #[cfg(target_os = "macos")]
        {
            self.terminate_macos_generations()
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.terminate_posix_groups()
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn terminate_posix_groups(&self) -> Result<(), ClientError> {
        self.revalidate()?;
        let leader = checked_process_id(self.provider.process_id)?;
        // SAFETY: getpgrp has no arguments and dereferences no memory.
        let caller_group = unsafe { libc::getpgrp() };
        let mut groups = BTreeMap::from([(leader, leader)]);
        let mut stopped = BTreeSet::new();
        let mut stable_snapshots = 0;
        let mut complete = true;
        let mut freeze_error = None;

        for _ in 0..FREEZE_ROUNDS {
            let snapshot = match provider_process_groups(leader) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    freeze_error = Some(error);
                    break;
                }
            };
            let previous = groups.clone();
            groups.extend(snapshot);
            for (&group, &witness) in &groups {
                if stopped.contains(&group) {
                    continue;
                }
                match provider_group_is_frozen(leader, group) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => {
                        freeze_error = Some(error);
                        break;
                    }
                }
                match signal_provider_group(leader, caller_group, group, witness, libc::SIGSTOP) {
                    Ok(true) => {
                        stopped.insert(group);
                    }
                    Ok(false) | Err(_) => complete = false,
                }
            }
            let frozen = match wait_until_frozen(leader, FREEZE_VERIFICATION_TIMEOUT) {
                Ok(frozen) => frozen,
                Err(error) => {
                    freeze_error = Some(error);
                    break;
                }
            };
            if !frozen {
                complete = false;
            }
            if groups == previous && frozen {
                stable_snapshots += 1;
                if stable_snapshots >= REQUIRED_STABLE_SNAPSHOTS {
                    break;
                }
            } else {
                stable_snapshots = 0;
            }
        }

        if freeze_error.is_some() || !complete || stable_snapshots < REQUIRED_STABLE_SNAPSHOTS {
            resume_stopped_groups(leader, caller_group, &stopped)?;
            if let Some(error) = freeze_error {
                return Err(termination_failed(error));
            }
            return Err(ClientError::transport(
                "hmux_legacy_termination_incomplete",
                "legacy Hmux provider termination stopped before kill because a complete frozen process-session census could not be proven",
            ));
        }
        if let Err(error) = self.revalidate() {
            resume_stopped_groups(leader, caller_group, &stopped)?;
            return Err(error);
        }
        let process_session_terminated =
            kill_provider_process_session(leader, caller_group, KILL_VERIFICATION_TIMEOUT)
                .map_err(termination_failed)?;
        let provider_terminated = require_provider_terminated(&self.provider).is_ok();
        if !process_session_terminated || !provider_terminated {
            return Err(ClientError::transport(
                "hmux_legacy_termination_incomplete",
                "legacy Hmux provider termination could not prove complete process-session cleanup",
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn terminate_macos_generations(&self) -> Result<(), ClientError> {
        self.revalidate()?;
        let leader = checked_process_id(self.provider.process_id)?;
        let provider = observe_process(self.provider.process_id)
            .and_then(|observed| verify_process(&self.provider, observed))
            .map_err(|reason| verification_refused("provider", reason))?;
        let PlatformStartIdentity::MacOs {
            unique_id: leader_unique_id,
            ..
        } = provider.platform_start_identity;
        let mut captured = BTreeSet::new();
        let mut stopped = BTreeSet::new();
        let leader_generation = MacProcessGeneration {
            process_id: self.provider.process_id,
            unique_id: leader_unique_id,
        };
        let mut leader_retired = false;

        // A stable cut can be invalidated by an external SIGCONT immediately
        // after it is observed. Keep the exact leader alive as the census
        // anchor, retire descendants, and then census again before crossing
        // the leader's destructive boundary.
        for _ in 0..FREEZE_ROUNDS {
            let mut stable_snapshots = 0;
            let mut failure = None;
            for _ in 0..FREEZE_ROUNDS {
                if let Err(error) = self.revalidate() {
                    failure = Some(error);
                    break;
                }
                let snapshot =
                    match macos_provider_generations(leader, leader_unique_id, &captured, true) {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            failure = Some(termination_failed(error));
                            break;
                        }
                    };
                let changed = !snapshot.is_subset(&captured);
                captured.extend(snapshot);
                let descendants = macos_provider_descendants(&captured, leader_generation);
                if let Some(error) = stop_macos_generations(&descendants, &mut stopped) {
                    failure = Some(termination_failed(error));
                    break;
                }
                let frozen = match macos_generations_are_frozen(&descendants) {
                    Ok(frozen) => frozen,
                    Err(error) => {
                        failure = Some(termination_failed(error));
                        break;
                    }
                };
                let after =
                    match macos_provider_generations(leader, leader_unique_id, &captured, true) {
                        Ok(after) => after,
                        Err(error) => {
                            failure = Some(termination_failed(error));
                            break;
                        }
                    };
                if frozen && !changed && after.is_subset(&captured) {
                    stable_snapshots += 1;
                } else {
                    captured.extend(after);
                    stable_snapshots = 0;
                }
                if stable_snapshots >= REQUIRED_STABLE_SNAPSHOTS {
                    // Recheck both the frozen state and the leader-anchored
                    // census at the final cut. A SIGCONT/fork between the two
                    // stable samples sends the algorithm back through freeze.
                    if let Err(error) = self.revalidate() {
                        failure = Some(error);
                        break;
                    }
                    let final_descendants =
                        macos_provider_descendants(&captured, leader_generation);
                    let final_frozen = match macos_generations_are_frozen(&final_descendants) {
                        Ok(frozen) => frozen,
                        Err(error) => {
                            failure = Some(termination_failed(error));
                            break;
                        }
                    };
                    let final_snapshot =
                        match macos_provider_generations(leader, leader_unique_id, &captured, true)
                        {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                failure = Some(termination_failed(error));
                                break;
                            }
                        };
                    if macos_frozen_cut_is_stable(&captured, final_frozen, &final_snapshot) {
                        break;
                    }
                    captured.extend(final_snapshot);
                    stable_snapshots = 0;
                }
            }

            if let Some(error) = failure {
                return abort_macos_termination(&stopped, error);
            }
            if stable_snapshots < REQUIRED_STABLE_SNAPSHOTS {
                return abort_macos_termination(
                    &stopped,
                    ClientError::transport(
                        "hmux_legacy_termination_incomplete",
                        "legacy Hmux provider termination stopped before kill because a complete exact-generation census could not be proven",
                    ),
                );
            }
            if !captured.contains(&leader_generation) {
                return abort_macos_termination(
                    &stopped,
                    verification_refused(
                        "provider",
                        io::Error::other("provider leader is absent from the frozen census"),
                    ),
                );
            }

            let descendants = macos_provider_descendants(&captured, leader_generation);
            if let Some(error) = signal_macos_generations_best_effort(&descendants, libc::SIGKILL) {
                return abort_macos_termination(&stopped, termination_failed(error));
            }
            match wait_for_macos_generations_gone(&descendants, KILL_VERIFICATION_TIMEOUT) {
                Ok(true) => {}
                Ok(false) => {
                    return abort_macos_termination(
                        &stopped,
                        ClientError::transport(
                            "hmux_legacy_termination_incomplete",
                            "legacy Hmux provider descendants remained alive after exact termination",
                        ),
                    );
                }
                Err(error) => {
                    return abort_macos_termination(&stopped, termination_failed(error));
                }
            }

            if let Err(error) = self.revalidate() {
                return abort_macos_termination(&stopped, error);
            }
            let after_descendants =
                match macos_provider_generations(leader, leader_unique_id, &captured, true) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        return abort_macos_termination(&stopped, termination_failed(error));
                    }
                };
            captured.extend(after_descendants.iter().copied());
            if after_descendants == BTreeSet::from([leader_generation]) {
                match signal_process_generation(
                    leader_generation.process_id,
                    leader_generation.unique_id,
                    libc::SIGKILL,
                ) {
                    Ok(_) => {
                        leader_retired = true;
                        break;
                    }
                    Err(error) => {
                        return abort_macos_termination(&stopped, termination_failed(error));
                    }
                }
            }
        }

        if !leader_retired {
            return abort_macos_termination(
                &stopped,
                ClientError::transport(
                    "hmux_legacy_termination_incomplete",
                    "legacy Hmux provider kept creating exact descendants during bounded termination",
                ),
            );
        }

        // The leader can be externally resumed for the few instructions
        // between the final census and SIGKILL. Once it is retired no new
        // descendants can be created, so sweep exact lineage/session members
        // to two consecutive empty snapshots before reporting success.
        let mut empty_snapshots = 0;
        let mut cleanup_error = None;
        for _ in 0..FREEZE_ROUNDS {
            let remaining =
                match macos_provider_generations(leader, leader_unique_id, &captured, false) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        cleanup_error.get_or_insert(error);
                        continue;
                    }
                };
            if remaining.is_empty() {
                empty_snapshots += 1;
                if empty_snapshots >= REQUIRED_STABLE_SNAPSHOTS {
                    break;
                }
                continue;
            }
            empty_snapshots = 0;
            captured.extend(remaining.iter().copied());
            if let Some(error) = signal_macos_generations_best_effort(&remaining, libc::SIGKILL) {
                cleanup_error.get_or_insert(error);
            }
        }
        let all_captured_gone =
            wait_for_macos_generations_gone(&captured, KILL_VERIFICATION_TIMEOUT).unwrap_or(false);
        if cleanup_error.is_some()
            || empty_snapshots < REQUIRED_STABLE_SNAPSHOTS
            || !all_captured_gone
            || require_provider_terminated(&self.provider).is_err()
        {
            let primary = cleanup_error.map_or_else(
                || {
                    ClientError::transport(
                        "hmux_legacy_termination_incomplete",
                        "legacy Hmux provider termination could not prove exact process-generation cleanup",
                    )
                },
                termination_failed,
            );
            return abort_macos_termination(&stopped, primary);
        }
        Ok(())
    }

    fn revalidate(&self) -> Result<(), ClientError> {
        let host = observe_process(self.host.process_id)
            .and_then(|observed| verify_process(&self.host, observed))
            .map_err(|reason| verification_refused("Host", reason))?;
        let provider = observe_process(self.provider.process_id)
            .and_then(|observed| verify_process(&self.provider, observed))
            .map_err(|reason| verification_refused("provider", reason))?;
        verify_process_tree(host, provider)
    }
}

#[cfg(target_os = "macos")]
fn macos_provider_generations(
    leader: libc::pid_t,
    leader_unique_id: u64,
    known: &BTreeSet<MacProcessGeneration>,
    require_live_leader: bool,
) -> io::Result<BTreeSet<MacProcessGeneration>> {
    let leader_id = u32::try_from(leader)
        .map_err(|_| io::Error::other("provider leader process id is out of range"))?;
    if require_live_leader && !process_unique_generation_is_current(leader_id, leader_unique_id)? {
        return Err(io::Error::other(
            "provider leader generation changed during process census",
        ));
    }
    let mut lineages = Vec::new();
    for process in process_ids()? {
        if process <= 1 {
            continue;
        }
        let process_id = u32::try_from(process)
            .map_err(|_| io::Error::other("provider member process id is out of range"))?;
        let identity = match process_unique_identity(process_id) {
            Ok(identity) => identity,
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
            Err(error) => return Err(error),
        };
        lineages.push(MacProcessLineage {
            generation: MacProcessGeneration {
                process_id,
                unique_id: identity.unique_id,
            },
            parent_unique_id: identity.parent_unique_id,
        });
    }

    let mut readable = BTreeSet::new();
    let mut outside_session = BTreeSet::new();
    let mut permission_denied = BTreeSet::new();
    for lineage in &lineages {
        let observed = match observe_process(lineage.generation.process_id) {
            Ok(observed) => observed,
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                permission_denied.insert(lineage.generation);
                continue;
            }
            Err(error) => return Err(error),
        };
        let PlatformStartIdentity::MacOs { unique_id, .. } = observed.platform_start_identity;
        if unique_id != lineage.generation.unique_id {
            continue;
        }
        let process = libc::pid_t::try_from(lineage.generation.process_id)
            .map_err(|_| io::Error::other("provider member process id is out of range"))?;
        match process_is_zombie(process) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
            Err(error) => return Err(error),
        }
        if observed.process_session_id == leader_id {
            readable.insert(lineage.generation);
        } else {
            outside_session.insert(lineage.generation);
        }
    }

    let owned = macos_owned_unique_ids(
        &lineages,
        known,
        &readable,
        leader_unique_id,
        require_live_leader,
    )?;
    if let Some(generation) = permission_denied
        .iter()
        .find(|generation| owned.contains(&generation.unique_id))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "provider descendant {} denied exact BSD/session inspection",
                generation.process_id
            ),
        ));
    }
    if let Some(generation) = outside_session
        .iter()
        .find(|generation| owned.contains(&generation.unique_id))
    {
        return Err(io::Error::other(format!(
            "provider descendant {} escaped the provider POSIX session",
            generation.process_id
        )));
    }

    let generations = lineages
        .iter()
        .filter(|lineage| owned.contains(&lineage.generation.unique_id))
        .map(|lineage| lineage.generation)
        .collect::<BTreeSet<_>>();
    if require_live_leader
        && !generations.contains(&MacProcessGeneration {
            process_id: leader_id,
            unique_id: leader_unique_id,
        })
    {
        return Err(io::Error::other(
            "provider leader is absent from the exact process census",
        ));
    }
    if require_live_leader && !process_unique_generation_is_current(leader_id, leader_unique_id)? {
        return Err(io::Error::other(
            "provider leader generation changed during process census",
        ));
    }
    Ok(generations)
}

#[cfg(target_os = "macos")]
fn macos_admit_lineage(
    lineages: &[MacProcessLineage],
    mut owned_unique_ids: BTreeSet<u64>,
) -> BTreeSet<u64> {
    loop {
        let before = owned_unique_ids.len();
        for lineage in lineages {
            if owned_unique_ids.contains(&lineage.parent_unique_id) {
                owned_unique_ids.insert(lineage.generation.unique_id);
            }
        }
        if owned_unique_ids.len() == before {
            return owned_unique_ids;
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_owned_unique_ids(
    lineages: &[MacProcessLineage],
    known: &BTreeSet<MacProcessGeneration>,
    readable_session_members: &BTreeSet<MacProcessGeneration>,
    leader_unique_id: u64,
    require_live_leader: bool,
) -> io::Result<BTreeSet<u64>> {
    let mut ownership_roots = known
        .iter()
        .map(|generation| generation.unique_id)
        .collect::<BTreeSet<_>>();
    ownership_roots.insert(leader_unique_id);
    if require_live_leader {
        // A verified-live exact leader owns its numeric POSIX session. Once
        // that leader is gone the same PID/SID can be reused, so SID members
        // must never become new roots in post-leader cleanup.
        ownership_roots.extend(
            readable_session_members
                .iter()
                .map(|generation| generation.unique_id),
        );
    }
    let owned = macos_admit_lineage(lineages, ownership_roots);
    if !require_live_leader
        && readable_session_members
            .iter()
            .any(|generation| !owned.contains(&generation.unique_id))
    {
        return Err(io::Error::other(
            "post-leader process census found an ambiguous reused POSIX session",
        ));
    }
    Ok(owned)
}

#[cfg(target_os = "macos")]
fn macos_provider_descendants(
    generations: &BTreeSet<MacProcessGeneration>,
    leader: MacProcessGeneration,
) -> BTreeSet<MacProcessGeneration> {
    generations
        .iter()
        .copied()
        .filter(|generation| *generation != leader)
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_generations_are_frozen(generations: &BTreeSet<MacProcessGeneration>) -> io::Result<bool> {
    for generation in generations {
        if !process_unique_generation_is_current(generation.process_id, generation.unique_id)? {
            continue;
        }
        let process = libc::pid_t::try_from(generation.process_id)
            .map_err(|_| io::Error::other("provider member process id is out of range"))?;
        if !process_is_stopped_or_zombie(process)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn macos_frozen_cut_is_stable(
    captured: &BTreeSet<MacProcessGeneration>,
    all_descendants_frozen: bool,
    fresh: &BTreeSet<MacProcessGeneration>,
) -> bool {
    all_descendants_frozen && fresh.is_subset(captured)
}

#[cfg(target_os = "macos")]
fn stop_macos_generations(
    generations: &BTreeSet<MacProcessGeneration>,
    stopped: &mut BTreeSet<MacProcessGeneration>,
) -> Option<io::Error> {
    stop_macos_generations_with(generations, stopped, |generation, signal| {
        signal_process_generation(generation.process_id, generation.unique_id, signal)
    })
}

#[cfg(target_os = "macos")]
fn stop_macos_generations_with(
    generations: &BTreeSet<MacProcessGeneration>,
    stopped: &mut BTreeSet<MacProcessGeneration>,
    mut signal_generation: impl FnMut(MacProcessGeneration, libc::c_int) -> io::Result<bool>,
) -> Option<io::Error> {
    let mut first_error = None;
    for generation in generations.iter().copied() {
        // Reissue SIGSTOP on every freeze round. `stopped` records cleanup
        // ownership, not current state: an external actor may have delivered
        // SIGCONT since the previous census.
        match signal_generation(generation, libc::SIGSTOP) {
            Ok(true) => {
                stopped.insert(generation);
            }
            Ok(false) => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error
}

#[cfg(target_os = "macos")]
fn signal_macos_generations_best_effort(
    generations: &BTreeSet<MacProcessGeneration>,
    signal: libc::c_int,
) -> Option<io::Error> {
    signal_macos_generations_best_effort_with(generations, signal, |generation, signal| {
        signal_process_generation(generation.process_id, generation.unique_id, signal)
    })
}

#[cfg(target_os = "macos")]
fn signal_macos_generations_best_effort_with(
    generations: &BTreeSet<MacProcessGeneration>,
    signal: libc::c_int,
    mut signal_generation: impl FnMut(MacProcessGeneration, libc::c_int) -> io::Result<bool>,
) -> Option<io::Error> {
    let mut first_error = None;
    for generation in generations.iter().copied() {
        if let Err(error) = signal_generation(generation, signal) {
            first_error.get_or_insert(error);
        }
    }
    first_error
}

#[cfg(target_os = "macos")]
fn abort_macos_termination(
    stopped: &BTreeSet<MacProcessGeneration>,
    primary: ClientError,
) -> Result<(), ClientError> {
    match resume_macos_generations(stopped) {
        Ok(()) => Err(primary),
        Err(cleanup) => Err(ClientError::transport(
            "hmux_legacy_termination_failed",
            format!("{primary}; exact-generation cleanup also failed: {cleanup}"),
        )),
    }
}

#[cfg(target_os = "macos")]
fn resume_macos_generations(stopped: &BTreeSet<MacProcessGeneration>) -> Result<(), ClientError> {
    let mut errors = Vec::new();
    for generation in stopped {
        if let Err(error) =
            signal_process_generation(generation.process_id, generation.unique_id, libc::SIGCONT)
        {
            errors.push(format!(
                "SIGCONT for pid {} generation {} failed: {error}",
                generation.process_id, generation.unique_id
            ));
        }
    }
    let deadline = Instant::now() + THAW_VERIFICATION_TIMEOUT;
    loop {
        let mut frozen = false;
        for generation in stopped {
            match process_unique_generation_is_current(generation.process_id, generation.unique_id)
            {
                Ok(false) => continue,
                Ok(true) => {}
                Err(error) => {
                    errors.push(format!(
                        "pid {} generation {} could not be inspected after SIGCONT: {error}",
                        generation.process_id, generation.unique_id
                    ));
                    frozen = true;
                    continue;
                }
            }
            let process = match libc::pid_t::try_from(generation.process_id) {
                Ok(process) if process > 1 => process,
                _ => {
                    errors.push(format!(
                        "pid {} generation {} became invalid during cleanup",
                        generation.process_id, generation.unique_id
                    ));
                    frozen = true;
                    continue;
                }
            };
            match process_is_stopped(process) {
                Ok(true) => frozen = true,
                Ok(false) => {}
                Err(error) => {
                    errors.push(format!(
                        "pid {} generation {} stopped state could not be inspected: {error}",
                        generation.process_id, generation.unique_id
                    ));
                    frozen = true;
                }
            }
        }
        if !frozen {
            return if errors.is_empty() {
                Ok(())
            } else {
                Err(ClientError::transport(
                    "hmux_legacy_termination_failed",
                    format!(
                        "legacy Hmux provider termination resumed all observable exact generations, but cleanup reported: {}",
                        errors.join("; ")
                    ),
                ))
            };
        }
        if Instant::now() >= deadline {
            return Err(ClientError::transport(
                "hmux_legacy_termination_failed",
                format!(
                    "legacy Hmux provider termination aborted but an exact stopped generation did not resume{}",
                    if errors.is_empty() {
                        String::new()
                    } else {
                        format!("; cleanup reported: {}", errors.join("; "))
                    }
                ),
            ));
        }
        thread::sleep(PROCESS_STATE_POLL_INTERVAL);
    }
}

#[cfg(target_os = "macos")]
fn wait_for_macos_generations_gone(
    generations: &BTreeSet<MacProcessGeneration>,
    timeout: Duration,
) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let mut all_gone = true;
        for generation in generations {
            if !process_unique_generation_is_current(generation.process_id, generation.unique_id)? {
                continue;
            }
            let process = libc::pid_t::try_from(generation.process_id)
                .map_err(|_| io::Error::other("provider member process id is out of range"))?;
            if !process_is_zombie(process).unwrap_or(false) {
                all_gone = false;
                break;
            }
        }
        if all_gone {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(PROCESS_STATE_POLL_INTERVAL);
    }
}

#[cfg(not(target_os = "macos"))]
fn resume_stopped_groups(
    leader: libc::pid_t,
    caller_group: libc::pid_t,
    stopped: &BTreeSet<libc::pid_t>,
) -> Result<(), ClientError> {
    let deadline = Instant::now() + THAW_VERIFICATION_TIMEOUT;
    let mut stable_snapshots = 0;
    let mut last_signal_error = None;
    loop {
        let groups = provider_process_groups(leader).map_err(termination_failed)?;
        for group in stopped {
            if let Some(witness) = groups.get(group) {
                match signal_provider_group(leader, caller_group, *group, *witness, libc::SIGCONT) {
                    Ok(true) => {}
                    Ok(false) => stable_snapshots = 0,
                    Err(error) => {
                        stable_snapshots = 0;
                        last_signal_error = Some(error);
                    }
                }
            }
        }

        let mut affected_process_is_stopped = false;
        for process in session_members(leader).map_err(termination_failed)? {
            let Some(group) = process_group_if_present(process).map_err(termination_failed)? else {
                continue;
            };
            if stopped.contains(&group)
                && process_is_stopped(process).map_err(termination_failed)?
            {
                affected_process_is_stopped = true;
                break;
            }
        }
        if affected_process_is_stopped {
            stable_snapshots = 0;
        } else {
            stable_snapshots += 1;
            if stable_snapshots >= REQUIRED_EMPTY_SNAPSHOTS {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            if let Some(error) = last_signal_error {
                return Err(termination_failed(error));
            }
            return Err(ClientError::transport(
                "hmux_legacy_termination_failed",
                "legacy Hmux provider termination aborted but could not prove that every stopped process resumed",
            ));
        }
        thread::sleep(PROCESS_STATE_POLL_INTERVAL);
    }
}

fn verify_process_tree(
    host: ProcessObservation,
    provider: ProcessObservation,
) -> Result<(), ClientError> {
    if host.process_group_id != host.process_id
        || host.process_session_id != host.process_id
        || provider.parent_process_id != host.process_id
        || provider.process_group_id != provider.process_id
        || provider.process_session_id != provider.process_id
    {
        return Err(verification_refused(
            "process tree",
            io::Error::other(
                "Host/provider parent, process-group, or POSIX-session ownership changed",
            ),
        ));
    }
    Ok(())
}

fn verification_refused(subject: &str, reason: io::Error) -> ClientError {
    ClientError::transport(
        "hmux_legacy_termination_unverified",
        format!(
            "refusing legacy Hmux termination: {subject} identity is not verifiable ({reason})"
        ),
    )
}

fn termination_failed(reason: io::Error) -> ClientError {
    ClientError::transport(
        "hmux_legacy_termination_failed",
        format!("legacy Hmux provider termination failed: {reason}"),
    )
}

fn require_provider_terminated(provider: &ProcessDescriptor) -> Result<(), ClientError> {
    validate_process_marker(provider)?;
    let observed = match observe_process(provider.process_id) {
        Ok(observed) => observed,
        Err(_reason) if process_generation_is_absent(provider)? => return Ok(()),
        Err(reason) => return Err(verification_refused("provider", reason)),
    };
    match verify_process(provider, observed) {
        Ok(_) if process_is_zombie(checked_process_id(provider.process_id)?).unwrap_or(false) => {
            Ok(())
        }
        Ok(_) => Err(verification_refused(
            "provider",
            io::Error::other("provider is still running"),
        )),
        Err(_) => Ok(()),
    }
}

/// Read-only lifecycle posture for one discovery process generation.
///
/// `Absent` means the recorded generation is gone, has been replaced, or is
/// already in an irreversible kernel-exit state. It never authorizes adopting
/// or signaling the current numeric PID.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalProcessGenerationStatus {
    Live,
    Absent,
}

/// Inspects local process identity without delivering a signal.
///
/// Callers must fail closed on `Err`: it means the adapter could not prove
/// either the exact generation or its absence.
pub fn probe_local_process_generation(
    process: &ProcessDescriptor,
) -> Result<LocalProcessGenerationStatus, ClientError> {
    probe_local_process_generation_with(process, preflight_process_generation)
}

/// Proves that the exact provider generation is gone and its entire POSIX
/// session is empty across two complete process-table snapshots.
///
/// This is the read-only counterpart to the census used by legacy
/// termination. A surviving member or an incomplete census is not absence.
pub(crate) fn provider_process_session_is_stably_empty(
    provider: &ProcessDescriptor,
) -> Result<bool, ClientError> {
    let leader = checked_process_id(provider.process_id)?;
    for snapshot in 0..REQUIRED_EMPTY_SNAPSHOTS {
        if probe_local_process_generation(provider)? != LocalProcessGenerationStatus::Absent {
            return Ok(false);
        }
        let members = session_members(leader)
            .map_err(|error| verification_refused("provider process session", error))?;
        if !members.is_empty() {
            return Ok(false);
        }
        if snapshot + 1 < REQUIRED_EMPTY_SNAPSHOTS {
            thread::sleep(PROCESS_STATE_POLL_INTERVAL);
        }
    }
    Ok(true)
}

fn probe_local_process_generation_with(
    process: &ProcessDescriptor,
    preflight: impl FnOnce(u32, ProcessStartMarker) -> io::Result<Option<ProcessGenerationPreflight>>,
) -> Result<LocalProcessGenerationStatus, ClientError> {
    validate_process_marker(process)?;
    let parsed = parse_start_marker(&process.start_marker)
        .map_err(|error| verification_refused("process", error))?;
    match preflight(process.process_id, parsed) {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        Ok(Some(
            ProcessGenerationPreflight::Absent | ProcessGenerationPreflight::ExitInProgress,
        )) => {
            return Ok(LocalProcessGenerationStatus::Absent);
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        Ok(Some(ProcessGenerationPreflight::Current)) => {}
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        Ok(Some(impossible)) => match impossible {},
        Ok(None) => {}
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
            return Ok(LocalProcessGenerationStatus::Absent);
        }
        Err(error) => return Err(verification_refused("process", error)),
    }
    match observe_process(process.process_id) {
        Ok(observed) => match verify_process(process, observed) {
            Ok(_) => Ok(LocalProcessGenerationStatus::Live),
            Err(_) => Ok(LocalProcessGenerationStatus::Absent),
        },
        Err(observe_error) => {
            let process_id = checked_process_id(process.process_id)?;
            match process_session(process_id) {
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                    Ok(LocalProcessGenerationStatus::Absent)
                }
                Err(error) => Err(verification_refused("process", error)),
                Ok(_) => Err(verification_refused("process", observe_error)),
            }
        }
    }
}

fn process_generation_is_absent(process: &ProcessDescriptor) -> Result<bool, ClientError> {
    Ok(matches!(
        probe_local_process_generation(process)?,
        LocalProcessGenerationStatus::Absent
    ))
}

fn validate_process_marker(process: &ProcessDescriptor) -> Result<(), ClientError> {
    checked_process_id(process.process_id)?;
    match parse_start_marker(&process.start_marker)
        .map_err(|error| verification_refused("process", error))?
    {
        ProcessStartMarker::SpawnedAfter {
            process_id,
            unix_ms,
        } if process_id == process.process_id && unix_ms != 0 => {}
        #[cfg(target_os = "linux")]
        ProcessStartMarker::PlatformExact(_) => {}
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        ProcessStartMarker::MacOsUnique { .. }
        | ProcessStartMarker::MacOsUniqueV2 { .. }
        | ProcessStartMarker::MacOsLegacy { .. } => {}
        ProcessStartMarker::SpawnedAfter { .. } => {
            return Err(verification_refused(
                "process",
                io::Error::other("process start marker is not signal-safe"),
            ));
        }
    }
    Ok(())
}

fn signal_verified_host(
    expected: &ProcessDescriptor,
    caller_group: libc::pid_t,
    host_group: libc::pid_t,
    signal: libc::c_int,
) -> Result<(), ClientError> {
    let observed = observe_process(expected.process_id)
        .and_then(|observed| verify_process(expected, observed))
        .map_err(|reason| verification_refused("Host", reason))?;
    if observed.process_group_id != observed.process_id
        || observed.process_session_id != observed.process_id
        || host_group == caller_group
    {
        return Err(verification_refused(
            "Host",
            io::Error::other("Host process-group ownership changed"),
        ));
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let PlatformStartIdentity::MacOs { unique_id, .. } = observed.platform_start_identity;
        signal_process_generation(expected.process_id, unique_id, signal)
            .map(|_| ())
            .map_err(termination_failed)
    }
    // SAFETY: on platforms without a generation-fenced signal API, the exact
    // Host generation and its process-group ownership were revalidated
    // immediately above. The negative PID addresses that group.
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    if unsafe { libc::kill(-host_group, signal) } == 0 {
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let reason = io::Error::last_os_error();
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    if reason.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    Err(termination_failed(reason))
}

fn wait_until_process_exited(
    expected: &ProcessDescriptor,
    timeout: Duration,
) -> Result<bool, ClientError> {
    let deadline = Instant::now() + timeout;
    loop {
        match observe_process(expected.process_id) {
            Err(_) if process_generation_is_absent(expected)? => return Ok(true),
            Err(reason) => return Err(verification_refused("Host", reason)),
            Ok(observed) => match verify_process(expected, observed) {
                Err(_) => return Ok(true),
                Ok(_) => {
                    let process = checked_process_id(expected.process_id)?;
                    if process_is_zombie(process).unwrap_or(false) {
                        return Ok(true);
                    }
                }
            },
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(PROCESS_STATE_POLL_INTERVAL);
    }
}

fn checked_process_id(process_id: u32) -> Result<libc::pid_t, ClientError> {
    let process = libc::pid_t::try_from(process_id).map_err(|_| {
        verification_refused("process", io::Error::other("process id is out of range"))
    })?;
    if process <= 1 {
        return Err(verification_refused(
            "process",
            io::Error::other("process id is not signal-safe"),
        ));
    }
    Ok(process)
}

fn verify_process(
    expected: &ProcessDescriptor,
    observed: ProcessObservation,
) -> io::Result<ProcessObservation> {
    if observed.process_id != expected.process_id {
        return Err(io::Error::other("process id changed"));
    }
    match parse_start_marker(&expected.start_marker)? {
        ProcessStartMarker::SpawnedAfter {
            process_id,
            unix_ms,
        } => {
            if process_id != expected.process_id {
                return Err(io::Error::other(
                    "process start marker belongs to another process id",
                ));
            }
            let maximum_delay =
                u64::try_from(PROCESS_START_TOLERANCE.as_millis()).unwrap_or(u64::MAX);
            if unix_ms < observed.start_unix_ms || unix_ms - observed.start_unix_ms > maximum_delay
            {
                return Err(io::Error::other(
                    "OS process start time does not match the discovery marker",
                ));
            }
        }
        #[cfg(target_os = "linux")]
        ProcessStartMarker::PlatformExact(identity) => {
            if identity != observed.platform_start_identity {
                return Err(io::Error::other(
                    "OS process start identity does not match the discovery marker",
                ));
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        ProcessStartMarker::MacOsUnique {
            unique_id,
            seconds,
            microseconds,
        } => match observed.platform_start_identity {
            PlatformStartIdentity::MacOs {
                unique_id: actual_unique_id,
                seconds: actual_seconds,
                microseconds: actual_microseconds,
                ..
            } if unique_id == actual_unique_id
                && seconds == actual_seconds
                && microseconds == actual_microseconds => {}
            _ => {
                return Err(io::Error::other(
                    "macOS unique process generation does not match the discovery marker",
                ));
            }
        },
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        ProcessStartMarker::MacOsUniqueV2 {
            unique_id,
            seconds,
            microseconds,
            ..
        } => match observed.platform_start_identity {
            PlatformStartIdentity::MacOs {
                unique_id: actual_unique_id,
                seconds: actual_seconds,
                microseconds: actual_microseconds,
                ..
            } if unique_id == actual_unique_id
                && seconds == actual_seconds
                && microseconds == actual_microseconds => {}
            _ => {
                return Err(io::Error::other(
                    "macOS v2 process generation does not match the discovery marker",
                ));
            }
        },
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        ProcessStartMarker::MacOsLegacy {
            seconds,
            microseconds,
        } => match observed.platform_start_identity {
            PlatformStartIdentity::MacOs {
                seconds: actual_seconds,
                microseconds: actual_microseconds,
                ..
            } if seconds == actual_seconds && microseconds == actual_microseconds => {}
            _ => {
                return Err(io::Error::other(
                    "legacy macOS process start identity does not match",
                ));
            }
        },
    }
    Ok(observed)
}

fn parse_start_marker(marker: &str) -> io::Result<ProcessStartMarker> {
    if let Some((process_id, unix_ms)) = marker
        .split_once('-')
        .filter(|(process_id, _)| process_id.bytes().all(|byte| byte.is_ascii_digit()))
    {
        let process_id = process_id
            .parse()
            .map_err(|_| io::Error::other("invalid process id in start marker"))?;
        let unix_ms = unix_ms
            .parse()
            .map_err(|_| io::Error::other("invalid timestamp in start marker"))?;
        return Ok(ProcessStartMarker::SpawnedAfter {
            process_id,
            unix_ms,
        });
    }
    if let Some(marker) = parse_platform_start_marker(marker) {
        return Ok(marker);
    }
    Err(io::Error::other("unsupported process start marker"))
}

fn current_process_session() -> Result<u32, ClientError> {
    // SAFETY: getsid reads kernel process metadata and dereferences no memory.
    let session = unsafe { libc::getsid(0) };
    if session < 0 {
        return Err(verification_refused("caller", io::Error::last_os_error()));
    }
    u32::try_from(session).map_err(|_| {
        verification_refused(
            "caller",
            io::Error::other("caller process session id is out of range"),
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn provider_process_groups(leader: libc::pid_t) -> io::Result<BTreeMap<libc::pid_t, libc::pid_t>> {
    let mut groups = BTreeMap::new();
    for process in process_ids()? {
        if process <= 1 || process_session_if_present(process)? != Some(leader) {
            continue;
        }
        let Some(group) = process_group_if_present(process)? else {
            continue;
        };
        if group <= 1 {
            continue;
        }
        groups
            .entry(group)
            .and_modify(|witness| {
                if process == group {
                    *witness = process;
                }
            })
            .or_insert(process);
    }
    Ok(groups)
}

fn process_session_if_present(process: libc::pid_t) -> io::Result<Option<libc::pid_t>> {
    match process_session(process) {
        Ok(session) => Ok(Some(session)),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(not(target_os = "macos"))]
fn process_group_if_present(process: libc::pid_t) -> io::Result<Option<libc::pid_t>> {
    match process_group(process) {
        Ok(group) => Ok(Some(group)),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(not(target_os = "macos"))]
fn signal_provider_group(
    leader: libc::pid_t,
    caller_group: libc::pid_t,
    group: libc::pid_t,
    witness: libc::pid_t,
    signal: libc::c_int,
) -> io::Result<bool> {
    if group <= 1 || group == caller_group {
        return Err(io::Error::other(
            "refusing to signal an invalid or caller-owned process group",
        ));
    }
    if process_session_if_present(witness)? != Some(leader)
        || process_group_if_present(witness)? != Some(group)
    {
        return Ok(false);
    }
    // SAFETY: the process-session and group ownership were revalidated
    // immediately above. A negative PID addresses that exact provider group.
    if unsafe { libc::kill(-group, signal) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(true);
    }
    Err(error)
}

fn session_members(leader: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let mut members = Vec::new();
    for process in process_ids()? {
        if process > 1 && process_session_if_present(process)? == Some(leader) {
            members.push(process);
        }
    }
    Ok(members)
}

#[cfg(not(target_os = "macos"))]
fn provider_group_is_frozen(leader: libc::pid_t, group: libc::pid_t) -> io::Result<bool> {
    let mut found = false;
    for process in session_members(leader)? {
        if process_group_if_present(process)? != Some(group) {
            continue;
        }
        found = true;
        if !process_is_stopped_or_zombie(process)? {
            return Ok(false);
        }
    }
    Ok(found)
}

#[cfg(not(target_os = "macos"))]
fn wait_until_frozen(leader: libc::pid_t, timeout: Duration) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let mut frozen = true;
        for process in session_members(leader)? {
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

#[cfg(not(target_os = "macos"))]
fn kill_provider_process_session(
    leader: libc::pid_t,
    caller_group: libc::pid_t,
    timeout: Duration,
) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    let mut last_signal_error = None;
    let mut empty_snapshots = 0;
    loop {
        let groups = provider_process_groups(leader)?;
        for (&group, &witness) in &groups {
            if let Err(error) =
                signal_provider_group(leader, caller_group, group, witness, libc::SIGKILL)
            {
                last_signal_error = Some(error);
            }
        }

        let members = session_members(leader)?;
        let descendants_exited = members.iter().all(|process| *process == leader);
        let leader_terminated = !members.contains(&leader) || process_is_zombie_or_absent(leader)?;
        if descendants_exited && leader_terminated {
            empty_snapshots += 1;
            if empty_snapshots >= REQUIRED_EMPTY_SNAPSHOTS {
                return Ok(true);
            }
        } else {
            empty_snapshots = 0;
        }
        if Instant::now() >= deadline {
            if let Some(error) = last_signal_error {
                return Err(error);
            }
            return Ok(false);
        }
        thread::sleep(PROCESS_STATE_POLL_INTERVAL);
    }
}

#[cfg(not(target_os = "macos"))]
fn process_is_zombie_or_absent(process: libc::pid_t) -> io::Result<bool> {
    match process_is_zombie(process) {
        Ok(zombie) => Ok(zombie),
        Err(observe_error) => match process_session(process) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
            Err(error) => Err(error),
            Ok(_) => Err(observe_error),
        },
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos", target_os = "ios")))]
mod tests {

    /// A marker this build cannot read is refused, never read as absence.
    ///
    /// `Absent` is acted on destructively — the phone's listing drops the row,
    /// the legacy termination path treats the process as safe to forget — so
    /// the only thing allowed to produce it is evidence that the recorded
    /// process is gone. `verify_process` returns `io::Error` for both "this pid
    /// is a different process now" and, on its own, "unsupported marker form";
    /// only the first is evidence. What keeps them apart is that
    /// `validate_process_marker` parses the marker *before* anything is
    /// observed, so an unreadable one leaves through `Err`.
    ///
    /// This pins that ordering. Moving the validation after the observation
    /// would turn every manifest written with a newer marker form into a
    /// session that silently disappears.
    #[test]
    fn an_unreadable_start_marker_is_refused_rather_than_read_as_absent() {
        let outcome = probe_local_process_generation(&ProcessDescriptor {
            // This process, so absence cannot be what is detected.
            process_id: std::process::id(),
            start_marker: "marker-form-from-a-newer-build".to_string(),
        });

        assert!(
            outcome.is_err(),
            "an unreadable marker proves nothing, so it must refuse rather than \
             report a status: {outcome:?}"
        );
    }
    use super::*;

    fn observation(start_unix_ms: u64) -> ProcessObservation {
        ProcessObservation {
            process_id: 42,
            parent_process_id: 10,
            process_group_id: 42,
            process_session_id: 42,
            start_unix_ms,
            platform_start_identity: platform_identity(1_700_000_000, 123_000),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn platform_identity(seconds: u64, subsecond: u64) -> PlatformStartIdentity {
        PlatformStartIdentity::MacOs {
            unique_id: 7,
            id_version: 3,
            seconds,
            microseconds: u32::try_from(subsecond).unwrap(),
        }
    }

    #[cfg(target_os = "linux")]
    fn platform_identity(_seconds: u64, subsecond: u64) -> PlatformStartIdentity {
        PlatformStartIdentity::Linux {
            boot_id: 0x0123456789abcdef0123456789abcdef,
            ticks: subsecond,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn platform_marker(seconds: u64, subsecond: u64) -> String {
        format!("macos-proc-unique-v3:7:{seconds}:{subsecond}")
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn macos_unique_marker_survives_exec_id_version_change() {
        let expected = ProcessDescriptor {
            process_id: 42,
            start_marker: "macos-proc-unique-v3:7:1700000000:123000".into(),
        };
        let mut after_exec = observation(1_700_000_000_123);
        after_exec.platform_start_identity = PlatformStartIdentity::MacOs {
            unique_id: 7,
            id_version: 4,
            seconds: 1_700_000_000,
            microseconds: 123_000,
        };

        assert_eq!(verify_process(&expected, after_exec).unwrap(), after_exec);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn macos_v2_unique_marker_remains_live_after_exec_id_version_change() {
        let expected = ProcessDescriptor {
            process_id: 42,
            start_marker: "macos-proc-unique-v2:7:3:1700000000:123000".into(),
        };
        let mut after_exec = observation(1_700_000_000_123);
        after_exec.platform_start_identity = PlatformStartIdentity::MacOs {
            unique_id: 7,
            id_version: 4,
            seconds: 1_700_000_000,
            microseconds: 123_000,
        };

        assert_eq!(verify_process(&expected, after_exec).unwrap(), after_exec);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_exact_signal_never_targets_a_different_unique_generation() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let observed = observe_process(child.id()).unwrap();
        let PlatformStartIdentity::MacOs { unique_id, .. } = observed.platform_start_identity;

        assert!(!signal_process_generation(child.id(), unique_id + 1, libc::SIGTERM).unwrap());
        assert!(child.try_wait().unwrap().is_none());
        assert!(signal_process_generation(child.id(), unique_id, libc::SIGTERM).unwrap());
        assert!(!child.wait().unwrap().success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_lineage_admission_is_fixed_point_order_independent_and_reuse_safe() {
        let leader = MacProcessLineage {
            generation: MacProcessGeneration {
                process_id: 10,
                unique_id: 100,
            },
            parent_unique_id: 1,
        };
        let child = MacProcessLineage {
            generation: MacProcessGeneration {
                process_id: 20,
                unique_id: 200,
            },
            parent_unique_id: 100,
        };
        let privileged_grandchild = MacProcessLineage {
            generation: MacProcessGeneration {
                process_id: 30,
                unique_id: 300,
            },
            parent_unique_id: 200,
        };
        let unrelated = MacProcessLineage {
            generation: MacProcessGeneration {
                process_id: 40,
                unique_id: 400,
            },
            parent_unique_id: 999,
        };

        let admitted = macos_admit_lineage(
            &[unrelated, privileged_grandchild, child, leader],
            BTreeSet::from([100]),
        );
        assert_eq!(admitted, BTreeSet::from([100, 200, 300]));

        let reused_child_pid = MacProcessLineage {
            generation: MacProcessGeneration {
                process_id: 20,
                unique_id: 201,
            },
            parent_unique_id: 999,
        };
        let after_reuse = macos_admit_lineage(&[reused_child_pid], BTreeSet::from([100, 200, 300]));
        assert!(!after_reuse.contains(&201));
        assert!(after_reuse.contains(&300));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_post_leader_census_never_promotes_reused_numeric_session() {
        let old_leader = MacProcessGeneration {
            process_id: 10,
            unique_id: 100,
        };
        let old_child = MacProcessGeneration {
            process_id: 20,
            unique_id: 200,
        };
        let known = BTreeSet::from([old_leader, old_child]);
        let reused_leader = MacProcessGeneration {
            process_id: 10,
            unique_id: 900,
        };
        let reused_child = MacProcessGeneration {
            process_id: 40,
            unique_id: 901,
        };
        let reused_lineage = [
            MacProcessLineage {
                generation: reused_leader,
                parent_unique_id: 999,
            },
            MacProcessLineage {
                generation: reused_child,
                parent_unique_id: 900,
            },
        ];
        let reused_session = BTreeSet::from([reused_leader, reused_child]);
        assert!(
            macos_owned_unique_ids(&reused_lineage, &known, &reused_session, 100, false).is_err(),
            "a reused numeric SID is ambiguous after its exact leader retired"
        );

        let late_owned_child = MacProcessGeneration {
            process_id: 50,
            unique_id: 300,
        };
        let owned = macos_owned_unique_ids(
            &[MacProcessLineage {
                generation: late_owned_child,
                parent_unique_id: 100,
            }],
            &known,
            &BTreeSet::from([late_owned_child]),
            100,
            false,
        )
        .unwrap();
        assert!(owned.contains(&300));
        assert!(!owned.contains(&900));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_freeze_projection_keeps_the_exact_leader_running() {
        let leader = MacProcessGeneration {
            process_id: 10,
            unique_id: 100,
        };
        let child = MacProcessGeneration {
            process_id: 20,
            unique_id: 200,
        };
        let reused_child_pid = MacProcessGeneration {
            process_id: 20,
            unique_id: 201,
        };

        let captured = BTreeSet::from([leader, child, reused_child_pid]);
        assert_eq!(
            macos_provider_descendants(&captured, leader),
            BTreeSet::from([child, reused_child_pid]),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_exact_signal_failures_do_not_short_circuit_stop_thaw_or_kill() {
        let generations = BTreeSet::from([
            MacProcessGeneration {
                process_id: 10,
                unique_id: 100,
            },
            MacProcessGeneration {
                process_id: 20,
                unique_id: 200,
            },
            MacProcessGeneration {
                process_id: 30,
                unique_id: 300,
            },
        ]);
        let mut stopped = BTreeSet::new();
        let mut stop_calls = Vec::new();
        let stop_error =
            stop_macos_generations_with(&generations, &mut stopped, |generation, signal| {
                stop_calls.push((generation, signal));
                if generation.process_id == 30 {
                    Err(io::Error::other("injected third stop failure"))
                } else {
                    Ok(true)
                }
            });
        assert!(stop_error.is_some());
        assert_eq!(stop_calls.len(), 3);
        assert_eq!(stopped.len(), 2);

        let mut thaw_calls = Vec::new();
        let thaw_error = signal_macos_generations_best_effort_with(
            &generations,
            libc::SIGCONT,
            |generation, signal| {
                thaw_calls.push((generation, signal));
                if generation.process_id == 20 {
                    Err(io::Error::other("injected second thaw failure"))
                } else {
                    Ok(true)
                }
            },
        );
        assert!(thaw_error.is_some());
        assert_eq!(thaw_calls.len(), 3);

        let mut kill_calls = Vec::new();
        let kill_error = signal_macos_generations_best_effort_with(
            &generations,
            libc::SIGKILL,
            |generation, signal| {
                kill_calls.push((generation, signal));
                if generation.process_id == 20 {
                    Err(io::Error::other("injected second kill failure"))
                } else {
                    Ok(true)
                }
            },
        );
        assert!(kill_error.is_some());
        assert_eq!(kill_calls.len(), 3);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_final_frozen_cut_rejects_resume_child_and_pid_reuse() {
        let leader = MacProcessGeneration {
            process_id: 10,
            unique_id: 100,
        };
        let child = MacProcessGeneration {
            process_id: 20,
            unique_id: 200,
        };
        let injected = MacProcessGeneration {
            process_id: 30,
            unique_id: 300,
        };
        let reused = MacProcessGeneration {
            process_id: 20,
            unique_id: 201,
        };
        let captured = BTreeSet::from([leader, child]);

        assert!(macos_frozen_cut_is_stable(&captured, true, &captured));
        assert!(!macos_frozen_cut_is_stable(&captured, false, &captured));
        assert!(!macos_frozen_cut_is_stable(
            &captured,
            true,
            &BTreeSet::from([leader, child, injected]),
        ));
        assert!(!macos_frozen_cut_is_stable(
            &captured,
            true,
            &BTreeSet::from([leader, reused]),
        ));
    }

    #[cfg(target_os = "linux")]
    fn platform_marker(_seconds: u64, subsecond: u64) -> String {
        format!(
            "linux-proc-start-v2:{:032x}:{subsecond}",
            0x0123456789abcdef0123456789abcdef_u128
        )
    }

    #[test]
    fn legacy_marker_accepts_matching_process_generation() {
        let expected = ProcessDescriptor {
            process_id: 42,
            start_marker: "42-1700000000123".into(),
        };
        assert_eq!(
            verify_process(&expected, observation(1_700_000_000_000)).unwrap(),
            observation(1_700_000_000_000)
        );
    }

    #[test]
    fn legacy_marker_rejects_pid_reuse_and_malformed_identity() {
        let reused = ProcessDescriptor {
            process_id: 42,
            start_marker: "42-1700000000123".into(),
        };
        assert!(verify_process(&reused, observation(1_700_000_100_000)).is_err());

        let wrong_pid = ProcessDescriptor {
            process_id: 42,
            start_marker: "41-1700000000123".into(),
        };
        assert!(verify_process(&wrong_pid, observation(1_700_000_000_000)).is_err());
        assert!(validate_process_marker(&wrong_pid).is_err());

        let malformed = ProcessDescriptor {
            process_id: 42,
            start_marker: "host-start".into(),
        };
        assert!(verify_process(&malformed, observation(1_700_000_000_000)).is_err());
        assert!(validate_process_marker(&malformed).is_err());

        let zero_timestamp = ProcessDescriptor {
            process_id: 42,
            start_marker: "42-0".into(),
        };
        assert!(validate_process_marker(&zero_timestamp).is_err());
    }

    #[test]
    fn legacy_marker_requires_proof_created_after_os_process_start() {
        let stale = ProcessDescriptor {
            process_id: 42,
            start_marker: "42-1699999999000".into(),
        };
        assert!(verify_process(&stale, observation(1_700_000_000_000)).is_err());
    }

    #[test]
    fn legacy_platform_marker_requires_an_exact_os_identity() {
        let observed = observation(1_700_000_000_000);
        let marker = platform_marker(1_700_000_000, 123_000);
        if parse_platform_start_marker(&marker).is_none() {
            return;
        }
        let expected = ProcessDescriptor {
            process_id: 42,
            start_marker: marker,
        };
        assert_eq!(verify_process(&expected, observed).unwrap(), observed);

        let changed = ProcessDescriptor {
            start_marker: platform_marker(1_700_000_000, 124_000),
            ..expected
        };
        assert!(verify_process(&changed, observed).is_err());

        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let legacy = ProcessDescriptor {
                process_id: 42,
                start_marker: "macos-proc-start:1700000000:123000".to_string(),
            };
            assert!(verify_process(&legacy, observed).is_ok());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_platform_marker_rejects_a_matching_tick_from_another_boot() {
        let observed = observation(1_700_000_000_000);
        let expected = ProcessDescriptor {
            process_id: 42,
            start_marker: platform_marker(1_700_000_000, 123_000),
        };
        assert!(verify_process(&expected, observed).is_ok());

        let another_boot = ProcessDescriptor {
            process_id: 42,
            start_marker: format!(
                "linux-proc-start-v2:{:032x}:123000",
                0xfedcba9876543210fedcba9876543210_u128
            ),
        };
        assert!(verify_process(&another_boot, observed).is_err());
        assert!(parse_platform_start_marker("linux-proc-start:123000").is_none());
    }

    #[test]
    fn local_process_probe_distinguishes_the_exact_generation_from_pid_reuse() {
        let process_id = std::process::id();
        let observed = observe_process(process_id).unwrap();
        let live = ProcessDescriptor {
            process_id,
            start_marker: format!("{process_id}-{}", observed.start_unix_ms),
        };
        assert_eq!(
            probe_local_process_generation(&live).unwrap(),
            LocalProcessGenerationStatus::Live
        );

        let reused = ProcessDescriptor {
            process_id,
            start_marker: format!("{process_id}-1"),
        };
        assert_eq!(
            probe_local_process_generation(&reused).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn local_process_probe_retires_an_exact_generation_already_in_exit() {
        let exact = exact_local_process_generation(std::process::id()).unwrap();

        assert_eq!(
            probe_local_process_generation_with(&exact, |_process_id, _marker| {
                Ok(Some(ProcessGenerationPreflight::ExitInProgress))
            })
            .unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }

    #[test]
    fn exact_generation_remains_live_after_legacy_startup_tolerance() {
        let process_id = std::process::id();
        let observed = observe_process(process_id).unwrap();
        let delayed_by = u64::try_from(PROCESS_START_TOLERANCE.as_millis()).unwrap() + 1;
        let delayed_legacy = ProcessDescriptor {
            process_id,
            start_marker: format!(
                "{process_id}-{}",
                observed.start_unix_ms.saturating_add(delayed_by)
            ),
        };
        assert_eq!(
            probe_local_process_generation(&delayed_legacy).unwrap(),
            LocalProcessGenerationStatus::Absent
        );

        let exact = exact_local_process_generation(process_id).unwrap();
        assert!(parse_platform_start_marker(&exact.start_marker).is_some());
        assert_eq!(
            probe_local_process_generation(&exact).unwrap(),
            LocalProcessGenerationStatus::Live
        );
    }
}
