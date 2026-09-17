#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "macos")]
use std::mem::{self, MaybeUninit};
#[cfg(target_os = "macos")]
use std::num::NonZeroU32;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use std::process::Command;

#[cfg(target_os = "macos")]
use mach2::mach_time::{mach_timebase_info, mach_timebase_info_data_t};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub rss_kib: u64,
    pub resident_kib: Option<u64>,
    pub physical_footprint_kib: Option<u64>,
    pub user_cpu_nanos: Option<u64>,
    pub system_cpu_nanos: Option<u64>,
    pub interrupt_wakeups: Option<u64>,
    pub package_idle_wakeups: Option<u64>,
    pub fd_count: Option<u64>,
    pub socket_count: Option<u64>,
}

#[cfg(target_os = "macos")]
pub fn process_sample(pid: u32) -> Option<ProcessSample> {
    let mut usage = MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: proc_pid_rusage receives a V4-sized writable buffer. The value
    // is read only after the kernel reports success.
    let result = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V4,
            usage.as_mut_ptr().cast::<libc::rusage_info_t>(),
        )
    };
    if result != 0 {
        return None;
    }
    // SAFETY: the successful call above initialized the complete V4 record.
    let usage = unsafe { usage.assume_init() };
    Some(macos_sample(
        pid,
        &usage,
        macos_fd_counts(pid)?,
        MachTimebase::read(),
    ))
}

#[cfg(target_os = "macos")]
fn macos_sample(
    pid: u32,
    usage: &libc::rusage_info_v4,
    (fd_count, socket_count): (u64, u64),
    timebase: Option<MachTimebase>,
) -> ProcessSample {
    ProcessSample {
        pid,
        rss_kib: usage.ri_resident_size / 1024,
        resident_kib: Some(usage.ri_resident_size / 1024),
        physical_footprint_kib: Some(usage.ri_phys_footprint / 1024),
        user_cpu_nanos: timebase.and_then(|timebase| timebase.to_nanos(usage.ri_user_time)),
        system_cpu_nanos: timebase.and_then(|timebase| timebase.to_nanos(usage.ri_system_time)),
        interrupt_wakeups: Some(usage.ri_interrupt_wkups),
        package_idle_wakeups: Some(usage.ri_pkg_idle_wkups),
        fd_count: Some(fd_count),
        socket_count: Some(socket_count),
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct MachTimebase {
    numerator: NonZeroU32,
    denominator: NonZeroU32,
}

#[cfg(target_os = "macos")]
impl MachTimebase {
    fn new(numerator: u32, denominator: u32) -> Option<Self> {
        Some(Self {
            numerator: NonZeroU32::new(numerator)?,
            denominator: NonZeroU32::new(denominator)?,
        })
    }

    fn read() -> Option<Self> {
        let mut timebase = MaybeUninit::<mach_timebase_info_data_t>::zeroed();
        // SAFETY: mach_timebase_info writes one correctly sized record. Read
        // the initialized record only after the native query succeeds.
        let result = unsafe { mach_timebase_info(timebase.as_mut_ptr()) };
        if result != 0 {
            return None;
        }
        // SAFETY: the successful query initialized the complete record.
        let timebase = unsafe { timebase.assume_init() };
        Self::new(timebase.numer, timebase.denom)
    }

    fn to_nanos(self, ticks: u64) -> Option<u64> {
        // Native CPU counters use Mach time. Multiply before dividing in a
        // wider integer so long-lived processes do not overflow mid-conversion.
        let nanos = u128::from(ticks) * u128::from(self.numerator.get())
            / u128::from(self.denominator.get());
        u64::try_from(nanos).ok()
    }
}

#[cfg(target_os = "macos")]
fn macos_fd_counts(pid: u32) -> Option<(u64, u64)> {
    let mut capacity = 64_usize;
    loop {
        let mut records = (0..capacity)
            .map(|_| MaybeUninit::<libc::proc_fdinfo>::uninit())
            .collect::<Vec<_>>();
        let buffer_bytes = capacity.checked_mul(mem::size_of::<libc::proc_fdinfo>())?;
        // SAFETY: records is a writable buffer of buffer_bytes. The kernel
        // reports how many complete proc_fdinfo bytes it initialized.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDLISTFDS,
                0,
                records.as_mut_ptr().cast::<libc::c_void>(),
                i32::try_from(buffer_bytes).ok()?,
            )
        };
        if written <= 0 {
            return None;
        }
        let count = written as usize / mem::size_of::<libc::proc_fdinfo>();
        if count < capacity {
            let socket_count = records
                .iter()
                .take(count)
                .filter(|record| {
                    // SAFETY: proc_pidinfo initialized the first count records.
                    (unsafe { record.assume_init_ref().proc_fdtype })
                        == libc::PROX_FDTYPE_SOCKET as u32
                })
                .count();
            return Some((count as u64, socket_count as u64));
        }
        if capacity >= 4096 {
            return None;
        }
        capacity *= 2;
    }
}

#[cfg(target_os = "linux")]
pub fn process_sample(pid: u32) -> Option<ProcessSample> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let rss_kib = status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
    })?;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat[stat.rfind(") ")? + 2..]
        .split_whitespace()
        .collect::<Vec<_>>();
    let user_ticks = fields.get(11)?.parse::<u64>().ok()?;
    let system_ticks = fields.get(12)?.parse::<u64>().ok()?;
    // SAFETY: sysconf is a read-only query with the constant _SC_CLK_TCK.
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks_per_second <= 0 {
        return None;
    }
    let fd_directory = fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    let mut fd_count = 0_u64;
    let mut socket_count = 0_u64;
    for entry in fd_directory.flatten() {
        fd_count += 1;
        if fs::read_link(entry.path())
            .ok()
            .is_some_and(|target| target.to_string_lossy().starts_with("socket:["))
        {
            socket_count += 1;
        }
    }
    let ticks_per_second = ticks_per_second as u64;
    Some(ProcessSample {
        pid,
        rss_kib,
        resident_kib: Some(rss_kib),
        physical_footprint_kib: None,
        user_cpu_nanos: Some(user_ticks.saturating_mul(1_000_000_000) / ticks_per_second),
        system_cpu_nanos: Some(system_ticks.saturating_mul(1_000_000_000) / ticks_per_second),
        interrupt_wakeups: None,
        package_idle_wakeups: None,
        fd_count: Some(fd_count),
        socket_count: Some(socket_count),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_sample(pid: u32) -> Option<ProcessSample> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "rss="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let rss_kib = String::from_utf8(output.stdout).ok()?.trim().parse().ok()?;
    Some(ProcessSample {
        pid,
        rss_kib,
        resident_kib: None,
        physical_footprint_kib: None,
        user_cpu_nanos: None,
        system_cpu_nanos: None,
        interrupt_wakeups: None,
        package_idle_wakeups: None,
        fd_count: None,
        socket_count: None,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDelta {
    pub user_cpu_nanos: Option<u64>,
    pub system_cpu_nanos: Option<u64>,
    pub interrupt_wakeups: Option<u64>,
    pub package_idle_wakeups: Option<u64>,
}

impl ProcessDelta {
    pub fn between(before: &ProcessSample, after: &ProcessSample) -> Self {
        Self {
            user_cpu_nanos: optional_delta(before.user_cpu_nanos, after.user_cpu_nanos),
            system_cpu_nanos: optional_delta(before.system_cpu_nanos, after.system_cpu_nanos),
            interrupt_wakeups: optional_delta(before.interrupt_wakeups, after.interrupt_wakeups),
            package_idle_wakeups: optional_delta(
                before.package_idle_wakeups,
                after.package_idle_wakeups,
            ),
        }
    }

    pub fn total_cpu_nanos(&self) -> Option<u64> {
        Some(self.user_cpu_nanos?.saturating_add(self.system_cpu_nanos?))
    }
}

fn optional_delta(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    Some(after?.saturating_sub(before?))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{MachTimebase, ProcessDelta, macos_sample};

    #[test]
    fn native_cpu_timebase_normalizes_intel_and_apple_silicon_units() {
        assert_eq!(MachTimebase::new(1, 1).unwrap().to_nanos(97), Some(97));
        assert_eq!(
            MachTimebase::new(125, 3).unwrap().to_nanos(24_000_000),
            Some(1_000_000_000)
        );
    }

    #[test]
    fn native_cpu_timebase_preserves_large_values_without_intermediate_overflow() {
        assert_eq!(
            MachTimebase::new(3, 3).unwrap().to_nanos(u64::MAX),
            Some(u64::MAX)
        );
        assert_eq!(MachTimebase::new(125, 3).unwrap().to_nanos(u64::MAX), None);
    }

    #[test]
    fn native_cpu_timebase_rejects_unusable_ratios() {
        assert!(MachTimebase::new(0, 1).is_none());
        assert!(MachTimebase::new(1, 0).is_none());
        assert!(MachTimebase::new(0, 0).is_none());
    }

    #[test]
    fn native_cpu_unavailable_keeps_resource_evidence_and_measured_zero_distinct() {
        // SAFETY: rusage_info_v4 contains only integer fields and byte arrays;
        // zero is valid for each field of this fixture record.
        let mut usage = unsafe { std::mem::zeroed::<libc::rusage_info_v4>() };
        usage.ri_resident_size = 2_048;
        usage.ri_phys_footprint = 1_024;
        let unavailable = macos_sample(7, &usage, (5, 2), None);
        let report = serde_json::to_value(&unavailable).unwrap();
        assert!(report["userCpuNanos"].is_null());
        assert!(report["systemCpuNanos"].is_null());
        assert_eq!(report["residentKib"], 2);
        assert_eq!(report["physicalFootprintKib"], 1);
        assert_eq!(report["fdCount"], 5);
        assert_eq!(report["socketCount"], 2);
        assert_eq!(
            ProcessDelta::between(&unavailable, &unavailable).total_cpu_nanos(),
            None
        );

        let measured = macos_sample(7, &usage, (5, 2), MachTimebase::new(125, 3));
        assert_eq!(
            ProcessDelta::between(&measured, &measured).total_cpu_nanos(),
            Some(0)
        );
    }
}
