use super::{
    PlatformStartIdentity, ProcessGenerationPreflight, ProcessObservation, ProcessStartMarker,
    verification_refused,
};
use crate::ClientError;
use std::io;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
use std::path::Path;

#[cfg(target_os = "linux")]
use std::fs;

// Only the two process-census adapters below bound themselves with this;
// a platform with no adapter never counts anything.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
const MAX_PROCESS_IDS: usize = 1_000_000;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PROCESS_CENSUS_SLACK: usize = 256;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PROCESS_CENSUS_ATTEMPTS: usize = 4;

#[cfg(any(target_os = "macos", target_os = "ios"))]
const PROC_PIDUNIQIDENTIFIERINFO: libc::c_int = 17;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const MACOS_PROC_FLAG_INEXIT: u32 = 0x0000_0004;

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[repr(C)]
struct ProcUniqueIdentifierInfo {
    executable_uuid: [u8; 16],
    unique_id: u64,
    parent_unique_id: u64,
    id_version: i32,
    original_parent_id_version: i32,
    reserved_2: u64,
    reserved_3: u64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct MacProcessUniqueIdentity {
    pub(super) unique_id: u64,
    pub(super) parent_unique_id: u64,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const _: [(); 56] = [(); std::mem::size_of::<ProcUniqueIdentifierInfo>()];

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[repr(C)]
struct AuditToken {
    values: [u32; 8],
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const _: [(); 32] = [(); std::mem::size_of::<AuditToken>()];

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_signal_with_audittoken(token: *mut AuditToken, signal: libc::c_int) -> libc::c_int;
}

pub(super) fn process_session(process: libc::pid_t) -> io::Result<libc::pid_t> {
    // SAFETY: getsid reads kernel process metadata and dereferences no memory.
    let session = unsafe { libc::getsid(process) };
    if session >= 0 {
        Ok(session)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn process_group(process: libc::pid_t) -> io::Result<libc::pid_t> {
    // SAFETY: getpgid reads kernel process metadata and dereferences no memory.
    let group = unsafe { libc::getpgid(process) };
    if group >= 0 {
        Ok(group)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn observe_process(process_id: u32) -> io::Result<ProcessObservation> {
    let stat = fs::read_to_string(format!("/proc/{process_id}/stat"))?;
    let suffix = stat
        .rfind(')')
        .and_then(|end| stat.get(end + 1..))
        .ok_or_else(|| io::Error::other("process stat is malformed"))?;
    let fields = suffix.split_whitespace().collect::<Vec<_>>();
    let parent_process_id = parse_stat_field(&fields, 1, "parent process id")?;
    let process_group_id = parse_stat_field(&fields, 2, "process group id")?;
    let process_session_id = parse_stat_field(&fields, 3, "process session id")?;
    let start_ticks: u64 = parse_stat_field(&fields, 19, "process start ticks")?;
    // SAFETY: sysconf with _SC_CLK_TCK has no pointer arguments.
    let clock_ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if clock_ticks <= 0 {
        return Err(io::Error::other("system clock tick rate is unavailable"));
    }
    let boot_unix_seconds = linux_boot_unix_seconds()?;
    let boot_id = linux_boot_identity()?;
    let start_unix_ms = boot_unix_seconds
        .checked_mul(1_000)
        .and_then(|boot| {
            start_ticks
                .checked_mul(1_000)
                .map(|ticks| boot.saturating_add(ticks / clock_ticks as u64))
        })
        .ok_or_else(|| io::Error::other("process start time overflow"))?;
    Ok(ProcessObservation {
        process_id,
        parent_process_id,
        process_group_id,
        process_session_id,
        start_unix_ms,
        platform_start_identity: PlatformStartIdentity::Linux {
            boot_id,
            ticks: start_ticks,
        },
    })
}

#[cfg(target_os = "linux")]
fn parse_stat_field<T>(fields: &[&str], index: usize, name: &str) -> io::Result<T>
where
    T: std::str::FromStr,
{
    fields
        .get(index)
        .ok_or_else(|| io::Error::other(format!("process stat has no {name}")))?
        .parse()
        .map_err(|_| io::Error::other(format!("process stat has invalid {name}")))
}

#[cfg(target_os = "linux")]
fn linux_boot_unix_seconds() -> io::Result<u64> {
    fs::read_to_string("/proc/stat")?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))
        .ok_or_else(|| io::Error::other("boot time is absent from /proc/stat"))?
        .parse()
        .map_err(|_| io::Error::other("boot time in /proc/stat is invalid"))
}

#[cfg(target_os = "linux")]
fn linux_boot_identity() -> io::Result<u128> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let boot_id = boot_id.trim();
    if boot_id.len() != 36
        || !boot_id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(io::Error::other("Linux boot id is invalid"));
    }
    let compact = boot_id.replace('-', "");
    u128::from_str_radix(&compact, 16).map_err(|_| io::Error::other("Linux boot id is invalid"))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn observe_process(process_id: u32) -> io::Result<ProcessObservation> {
    let process = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    let unique_before = macos_process_unique_identifier(process)?;
    let info = macos_process_info(process)?;
    let process_session_id = u32::try_from(process_session(process)?)
        .map_err(|_| io::Error::other("process session id is out of range"))?;
    let unique = macos_process_unique_identifier(process)?;
    if unique_before.unique_id != unique.unique_id {
        return Err(io::Error::other(
            "process generation changed during macOS observation",
        ));
    }
    Ok(ProcessObservation {
        process_id: info.pbi_pid,
        parent_process_id: info.pbi_ppid,
        process_group_id: info.pbi_pgid,
        process_session_id,
        start_unix_ms: info
            .pbi_start_tvsec
            .checked_mul(1_000)
            .and_then(|seconds| seconds.checked_add(info.pbi_start_tvusec / 1_000))
            .ok_or_else(|| io::Error::other("process start time overflow"))?,
        platform_start_identity: PlatformStartIdentity::MacOs {
            unique_id: unique.unique_id,
            id_version: unique.id_version,
            seconds: info.pbi_start_tvsec,
            microseconds: u32::try_from(info.pbi_start_tvusec)
                .map_err(|_| io::Error::other("process start microseconds are out of range"))?,
        },
    })
}

/// Compares the permission-neutral XNU lifetime identifier before requesting
/// BSD/session metadata. A recycled PID owned by another security principal
/// can deny those richer reads, but an unequal unique id already proves that
/// the durable process generation is absent.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn preflight_process_generation(
    process_id: u32,
    marker: ProcessStartMarker,
) -> io::Result<Option<ProcessGenerationPreflight>> {
    let expected_unique_id = match marker {
        ProcessStartMarker::MacOsUnique { unique_id, .. }
        | ProcessStartMarker::MacOsUniqueV2 { unique_id, .. } => unique_id,
        _ => return Ok(None),
    };
    let process = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    preflight_macos_process_generation_with(
        process,
        expected_unique_id,
        macos_process_unique_identifier,
        macos_process_info,
    )
    .map(Some)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn preflight_macos_process_generation_with(
    process: libc::pid_t,
    expected_unique_id: u64,
    mut read_unique: impl FnMut(libc::pid_t) -> io::Result<ProcUniqueIdentifierInfo>,
    mut read_bsd: impl FnMut(libc::pid_t) -> io::Result<libc::proc_bsdinfo>,
) -> io::Result<ProcessGenerationPreflight> {
    let process_id =
        u32::try_from(process).map_err(|_| io::Error::other("process id is out of range"))?;
    let before = read_unique(process)?;
    if before.unique_id != expected_unique_id {
        return Ok(ProcessGenerationPreflight::Absent);
    }
    let bsd = read_bsd(process)?;
    if bsd.pbi_pid != process_id {
        return Err(io::Error::other(
            "process generation changed during macOS state observation",
        ));
    }
    let after = read_unique(process)?;
    if after.unique_id != expected_unique_id {
        return Ok(ProcessGenerationPreflight::Absent);
    }
    if bsd.pbi_flags & MACOS_PROC_FLAG_INEXIT == 0 {
        return Ok(ProcessGenerationPreflight::Current);
    }
    // XNU projects P_WEXIT through proc_bsdinfo as PROC_FLAG_INEXIT. Once the
    // same unique generation is in this irreversible state it cannot accept
    // input or fork, so lifecycle reconciliation may treat it as non-live.
    Ok(ProcessGenerationPreflight::ExitInProgress)
}

/// Signals only the XNU process generation carrying `expected_unique_id`.
/// The kernel consumes the current PID version in the audit token atomically
/// with signal delivery, closing the observe-then-signal PID reuse window.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn signal_process_generation(
    process_id: u32,
    expected_unique_id: u64,
    signal: libc::c_int,
) -> io::Result<bool> {
    let process = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    for _ in 0..3 {
        let info = match macos_process_unique_identifier(process) {
            Ok(info) => info,
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(true),
            Err(error) => return Err(error),
        };
        if info.unique_id != expected_unique_id {
            return Ok(false);
        }
        let mut token = AuditToken {
            values: [u32::MAX; 8],
        };
        token.values[5] = process_id;
        token.values[7] = u32::from_ne_bytes(info.id_version.to_ne_bytes());
        // SAFETY: XNU reads the complete initialized audit token during this
        // call. PID plus its current version identify one kernel generation.
        let error = unsafe { proc_signal_with_audittoken(&mut token, signal) };
        if error == 0 {
            return Ok(true);
        }
        if error != libc::ESRCH {
            return Err(io::Error::from_raw_os_error(error));
        }
    }
    Err(io::Error::other(
        "process identity kept changing during exact signal delivery",
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn process_unique_generation_is_current(
    process_id: u32,
    expected_unique_id: u64,
) -> io::Result<bool> {
    let process = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    match macos_process_unique_identifier(process) {
        Ok(info) => Ok(info.unique_id == expected_unique_id),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Reads XNU's permission-neutral lifetime and parent-lifetime identifiers.
///
/// The parent identifier lets the destructive census establish provider
/// ancestry before it asks for BSD/session metadata, which a setuid child can
/// legitimately deny after it was launched by the provider.
#[cfg(target_os = "macos")]
pub(super) fn process_unique_identity(process_id: u32) -> io::Result<MacProcessUniqueIdentity> {
    let process = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    let info = macos_process_unique_identifier(process)?;
    Ok(MacProcessUniqueIdentity {
        unique_id: info.unique_id,
        parent_unique_id: info.parent_unique_id,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(super) fn preflight_process_generation(
    _process_id: u32,
    _marker: ProcessStartMarker,
) -> io::Result<Option<ProcessGenerationPreflight>> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn macos_process_unique_identifier(process: libc::pid_t) -> io::Result<ProcUniqueIdentifierInfo> {
    let mut info = std::mem::MaybeUninit::<ProcUniqueIdentifierInfo>::zeroed();
    let expected = libc::c_int::try_from(std::mem::size_of::<ProcUniqueIdentifierInfo>())
        .map_err(|_| io::Error::other("unique process info buffer is too large"))?;
    // SAFETY: Apple XNU defines selector 17 as PROC_PIDUNIQIDENTIFIERINFO and
    // its stable API structure as exactly 56 bytes. The buffer is writable for
    // that full size and is initialized only when proc_pidinfo returns it.
    let actual = unsafe {
        libc::proc_pidinfo(
            process,
            PROC_PIDUNIQIDENTIFIERINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if actual != expected {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: proc_pidinfo initialized the complete structure above.
    let info = unsafe { info.assume_init() };
    if info.unique_id == 0 {
        return Err(io::Error::other("unique process identifier is zero"));
    }
    Ok(info)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn macos_process_info(process: libc::pid_t) -> io::Result<libc::proc_bsdinfo> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>())
        .map_err(|_| io::Error::other("process info buffer is too large"))?;
    // SAFETY: info points to a writable buffer of `expected` bytes, and
    // proc_pidinfo initializes a proc_bsdinfo for the requested process.
    let actual = unsafe {
        libc::proc_pidinfo(
            process,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if actual != expected {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: proc_pidinfo initialized the complete structure above.
    Ok(unsafe { info.assume_init() })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
pub(super) fn observe_process(_process_id: u32) -> io::Result<ProcessObservation> {
    Err(io::Error::other(
        "this platform has no verified process inspection adapter",
    ))
}

#[cfg(target_os = "linux")]
pub(super) fn verify_host_executable(process_id: u32) -> Result<(), ClientError> {
    let path = fs::read_link(format!("/proc/{process_id}/exe"))
        .map_err(|reason| verification_refused("Host executable", reason))?;
    verify_hmux_runtime_path(&path)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn verify_host_executable(process_id: u32) -> Result<(), ClientError> {
    use std::os::unix::ffi::OsStrExt;

    let process = libc::pid_t::try_from(process_id).map_err(|_| {
        verification_refused(
            "Host executable",
            io::Error::other("process id is out of range"),
        )
    })?;
    let mut buffer = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buffer is writable for its reported length and proc_pidpath
    // writes at most that many bytes.
    let actual = unsafe {
        libc::proc_pidpath(
            process,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).unwrap_or(u32::MAX),
        )
    };
    if actual <= 0 {
        return Err(verification_refused(
            "Host executable",
            io::Error::last_os_error(),
        ));
    }
    buffer.truncate(actual as usize);
    verify_hmux_runtime_path(Path::new(std::ffi::OsStr::from_bytes(&buffer)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
pub(super) fn verify_host_executable(_process_id: u32) -> Result<(), ClientError> {
    Err(verification_refused(
        "Host executable",
        io::Error::other("this platform has no executable identity adapter"),
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
fn verify_hmux_runtime_path(path: &Path) -> Result<(), ClientError> {
    let executable_name = path.file_name().and_then(|name| name.to_str());
    let installed_legacy_runtime = executable_name == Some("hebbian")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("bin")
        && path.ancestors().any(|ancestor| {
            ancestor.file_name().and_then(|name| name.to_str()) == Some("hmux-cli")
        });
    if executable_name == Some("hmux-runtime") || installed_legacy_runtime {
        Ok(())
    } else {
        Err(verification_refused(
            "Host executable",
            io::Error::other("running executable is not a recognized Hmux Host runtime"),
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn parse_platform_start_marker(marker: &str) -> Option<ProcessStartMarker> {
    if let Some(values) = marker.strip_prefix("macos-proc-unique-v3:") {
        let mut values = values.split(':');
        let unique_id = values.next()?.parse().ok().filter(|value| *value != 0)?;
        let seconds = values.next()?.parse().ok().filter(|value| *value != 0)?;
        let microseconds = values
            .next()?
            .parse()
            .ok()
            .filter(|value| *value < 1_000_000)?;
        if values.next().is_some() {
            return None;
        }
        return Some(ProcessStartMarker::MacOsUnique {
            unique_id,
            seconds,
            microseconds,
        });
    }
    if let Some(values) = marker.strip_prefix("macos-proc-unique-v2:") {
        let mut values = values.split(':');
        let unique_id = values.next()?.parse().ok().filter(|value| *value != 0)?;
        let id_version = values.next()?.parse().ok()?;
        let seconds = values.next()?.parse().ok().filter(|value| *value != 0)?;
        let microseconds = values
            .next()?
            .parse()
            .ok()
            .filter(|value| *value < 1_000_000)?;
        if values.next().is_some() {
            return None;
        }
        return Some(ProcessStartMarker::MacOsUniqueV2 {
            unique_id,
            id_version,
            seconds,
            microseconds,
        });
    }
    let values = marker.strip_prefix("macos-proc-start:")?;
    let (seconds, microseconds) = values.split_once(':')?;
    let seconds = seconds.parse().ok().filter(|value| *value != 0)?;
    let microseconds = microseconds
        .parse()
        .ok()
        .filter(|value| *value < 1_000_000)?;
    Some(ProcessStartMarker::MacOsLegacy {
        seconds,
        microseconds,
    })
}

#[cfg(target_os = "linux")]
pub(super) fn parse_platform_start_marker(marker: &str) -> Option<ProcessStartMarker> {
    let values = marker.strip_prefix("linux-proc-start-v2:")?;
    let (boot_id, ticks) = values.split_once(':')?;
    if boot_id.len() != 32 || !boot_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let boot_id = u128::from_str_radix(boot_id, 16).ok()?;
    let ticks = ticks.parse::<u64>().ok().filter(|value| *value != 0)?;
    Some(ProcessStartMarker::PlatformExact(
        PlatformStartIdentity::Linux { boot_id, ticks },
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
pub(super) fn parse_platform_start_marker(_marker: &str) -> Option<ProcessStartMarker> {
    None
}

#[cfg(target_os = "linux")]
pub(super) fn process_is_stopped_or_zombie(process: libc::pid_t) -> io::Result<bool> {
    let state = linux_process_state(process)?;
    Ok(matches!(state, b'T' | b't' | b'Z'))
}

#[cfg(target_os = "linux")]
pub(super) fn process_is_stopped(process: libc::pid_t) -> io::Result<bool> {
    Ok(matches!(linux_process_state(process)?, b'T' | b't'))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn process_is_stopped_or_zombie(process: libc::pid_t) -> io::Result<bool> {
    match macos_process_info(process) {
        Ok(info) => Ok(matches!(info.pbi_status, libc::SSTOP | libc::SZOMB)),
        Err(_) => match process_session(process) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
            Err(error) => Err(error),
            Ok(_) => Err(io::Error::other("process state inspection was incomplete")),
        },
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn process_is_stopped(process: libc::pid_t) -> io::Result<bool> {
    match macos_process_info(process) {
        Ok(info) => Ok(info.pbi_status == libc::SSTOP),
        Err(_) => match process_session(process) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(false),
            Err(error) => Err(error),
            Ok(_) => Err(io::Error::other("process state inspection was incomplete")),
        },
    }
}

#[cfg(target_os = "linux")]
pub(super) fn process_is_zombie(process: libc::pid_t) -> io::Result<bool> {
    Ok(linux_process_state(process)? == b'Z')
}

#[cfg(target_os = "linux")]
fn linux_process_state(process: libc::pid_t) -> io::Result<u8> {
    let stat = match fs::read_to_string(format!("/proc/{process}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(b'Z'),
        Err(error) => return Err(error),
    };
    stat.rfind(')')
        .and_then(|end| stat.get(end + 1..))
        .and_then(|suffix| suffix.split_whitespace().next())
        .and_then(|value| value.as_bytes().first())
        .copied()
        .ok_or_else(|| io::Error::other("process stat has no state"))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) fn process_is_zombie(process: libc::pid_t) -> io::Result<bool> {
    Ok(macos_process_info(process)?.pbi_status == libc::SZOMB)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
pub(super) fn process_is_zombie(_process: libc::pid_t) -> io::Result<bool> {
    Err(io::Error::other(
        "this platform has no process state inspection adapter",
    ))
}

#[cfg(all(test, any(target_os = "macos", target_os = "ios")))]
mod exit_state_tests {
    use super::*;

    fn identity(unique_id: u64) -> ProcUniqueIdentifierInfo {
        ProcUniqueIdentifierInfo {
            executable_uuid: [0; 16],
            unique_id,
            parent_unique_id: 1,
            id_version: 1,
            original_parent_id_version: 1,
            reserved_2: 0,
            reserved_3: 0,
        }
    }

    fn bsd_info(process: u32, flags: u32) -> libc::proc_bsdinfo {
        // SAFETY: proc_bsdinfo is a plain C data structure and all-zero is a
        // valid synthetic baseline for this state-classification test.
        let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
        info.pbi_pid = process;
        info.pbi_flags = flags;
        info
    }

    #[test]
    fn exact_proc_flag_inexit_is_terminal_for_liveness_reconciliation() {
        let mut identities = [identity(91), identity(91)].into_iter();
        let result = preflight_macos_process_generation_with(
            41_001,
            91,
            |_| Ok(identities.next().unwrap()),
            |_| Ok(bsd_info(41_001, MACOS_PROC_FLAG_INEXIT)),
        )
        .unwrap();

        assert_eq!(result, ProcessGenerationPreflight::ExitInProgress);
    }

    #[test]
    fn a_changed_unique_generation_is_never_adopted_from_an_exiting_snapshot() {
        let mut identities = [identity(91), identity(92)].into_iter();
        let result = preflight_macos_process_generation_with(
            41_001,
            91,
            |_| Ok(identities.next().unwrap()),
            |_| Ok(bsd_info(41_001, MACOS_PROC_FLAG_INEXIT)),
        )
        .unwrap();

        assert_eq!(result, ProcessGenerationPreflight::Absent);
    }

    #[test]
    fn a_non_exiting_snapshot_cannot_adopt_a_replacement_generation() {
        let mut identities = [identity(91), identity(92)].into_iter();
        let result = preflight_macos_process_generation_with(
            41_001,
            91,
            |_| Ok(identities.next().unwrap()),
            |_| Ok(bsd_info(41_001, 0)),
        )
        .unwrap();

        assert_eq!(result, ProcessGenerationPreflight::Absent);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
pub(super) fn process_is_stopped_or_zombie(_process: libc::pid_t) -> io::Result<bool> {
    Err(io::Error::other(
        "this platform has no process state inspection adapter",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
pub(super) fn process_is_stopped(_process: libc::pid_t) -> io::Result<bool> {
    Err(io::Error::other(
        "this platform has no process state inspection adapter",
    ))
}

#[cfg(target_os = "linux")]
pub(super) fn process_ids() -> io::Result<Vec<libc::pid_t>> {
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
pub(super) fn process_ids() -> io::Result<Vec<libc::pid_t>> {
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
pub(super) fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    Err(io::Error::other(
        "this platform has no process census adapter",
    ))
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos", target_os = "ios")))]
mod tests {
    use super::*;

    #[test]
    fn host_executable_accepts_current_and_installed_legacy_runtimes_only() {
        assert!(verify_hmux_runtime_path(Path::new("/opt/hmux-runtime")).is_ok());
        assert!(
            verify_hmux_runtime_path(Path::new(
                "/Users/fixture/.local/share/hmux-cli/bin/hebbian"
            ))
            .is_ok()
        );
        assert!(verify_hmux_runtime_path(Path::new("/tmp/hebbian")).is_err());
        assert!(verify_hmux_runtime_path(Path::new("/tmp/other-runtime")).is_err());
    }
}
