use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

#[path = "native_process_sample.rs"]
mod native_process_sample;

use native_process_sample::{ProcessDelta, ProcessSample, process_sample};

#[cfg(all(test, target_os = "macos"))]
#[path = "process_cpu_contract.rs"]
mod cpu_contract;

#[derive(Clone, Debug)]
pub struct ProcessRow {
    pub pid: u32,
    pub parent_pid: u32,
    pub rss_kib: u64,
}

pub fn process_rows() -> Vec<ProcessRow> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss="])
        .output()
        .expect("ps must be available for the runtime scale fixture");
    assert!(output.status.success(), "ps failed");
    String::from_utf8(output.stdout)
        .expect("ps output must be UTF-8")
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 3 {
                return None;
            }
            Some(ProcessRow {
                pid: fields[0].parse().ok()?,
                parent_pid: fields[1].parse().ok()?,
                rss_kib: fields[2].parse().ok()?,
            })
        })
        .collect()
}

pub fn descendant_pids(rows: &[ProcessRow], root: u32) -> BTreeSet<u32> {
    let mut tree = BTreeSet::from([root]);
    loop {
        let previous_len = tree.len();
        for row in rows {
            if tree.contains(&row.parent_pid) {
                tree.insert(row.pid);
            }
        }
        if tree.len() == previous_len {
            break;
        }
    }
    tree.remove(&root);
    tree
}

pub fn wait_for_process_absence(processes: &BTreeSet<u32>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let rows = process_rows();
        if rows.iter().all(|row| !processes.contains(&row.pid)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "runtime scale fixture left a process alive: {:?}",
            rows.iter()
                .filter(|row| processes.contains(&row.pid))
                .map(|row| (row.pid, row.parent_pid, row.rss_kib))
                .collect::<Vec<_>>()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

pub fn sample_processes(processes: &BTreeSet<u32>) -> BTreeMap<u32, ProcessSample> {
    processes
        .iter()
        .filter_map(|pid| process_sample(*pid).map(|sample| (*pid, sample)))
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleMeasurement {
    pub role: String,
    pub process_count: usize,
    pub stable_process_count: usize,
    pub started_during_idle_count: usize,
    pub exited_during_idle_count: usize,
    pub rss_kib: u64,
    pub physical_footprint_kib: Option<u64>,
    pub fd_count: Option<u64>,
    pub socket_count: Option<u64>,
    pub idle_cpu_nanos: Option<u64>,
    pub idle_interrupt_wakeups: Option<u64>,
    pub idle_package_wakeups: Option<u64>,
}

pub fn measure_roles(
    before_roles: &BTreeMap<String, BTreeSet<u32>>,
    after_roles: &BTreeMap<String, BTreeSet<u32>>,
    before: &BTreeMap<u32, ProcessSample>,
    after: &BTreeMap<u32, ProcessSample>,
) -> Vec<RoleMeasurement> {
    before_roles
        .keys()
        .chain(after_roles.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|role| {
            let before_processes = before_roles
                .get(&role)
                .into_iter()
                .flatten()
                .filter(|pid| before.contains_key(pid))
                .copied()
                .collect::<BTreeSet<_>>();
            let after_processes = after_roles
                .get(&role)
                .into_iter()
                .flatten()
                .filter(|pid| after.contains_key(pid))
                .copied()
                .collect::<BTreeSet<_>>();
            let stable_processes = before_processes
                .intersection(&after_processes)
                .copied()
                .collect::<BTreeSet<_>>();
            let after_samples = after_processes
                .iter()
                .map(|pid| {
                    after
                        .get(pid)
                        .expect("role process missing from final sample")
                })
                .collect::<Vec<_>>();
            let deltas = stable_processes
                .iter()
                .map(|pid| {
                    ProcessDelta::between(
                        before
                            .get(pid)
                            .expect("role process missing from initial sample"),
                        after
                            .get(pid)
                            .expect("role process missing from final sample"),
                    )
                })
                .collect::<Vec<_>>();
            RoleMeasurement {
                role,
                process_count: after_processes.len(),
                stable_process_count: stable_processes.len(),
                started_during_idle_count: after_processes.difference(&before_processes).count(),
                exited_during_idle_count: before_processes.difference(&after_processes).count(),
                rss_kib: after_samples.iter().map(|sample| sample.rss_kib).sum(),
                physical_footprint_kib: sum_optional(
                    after_samples
                        .iter()
                        .map(|sample| sample.physical_footprint_kib),
                ),
                fd_count: sum_optional(after_samples.iter().map(|sample| sample.fd_count)),
                socket_count: sum_optional(after_samples.iter().map(|sample| sample.socket_count)),
                idle_cpu_nanos: sum_optional(deltas.iter().map(ProcessDelta::total_cpu_nanos)),
                idle_interrupt_wakeups: sum_optional(
                    deltas.iter().map(|delta| delta.interrupt_wakeups),
                ),
                idle_package_wakeups: sum_optional(
                    deltas.iter().map(|delta| delta.package_idle_wakeups),
                ),
            }
        })
        .collect()
}

pub fn role_processes(roles: &BTreeMap<String, BTreeSet<u32>>) -> BTreeSet<u32> {
    roles
        .values()
        .flat_map(|processes| processes.iter().copied())
        .collect()
}

pub fn sum_optional(mut values: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    values.try_fold(0_u64, |total, value| Some(total.saturating_add(value?)))
}

pub fn percentile(values: &[f64], quantile: f64) -> f64 {
    assert!(!values.is_empty(), "percentile needs at least one value");
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index]
}

pub fn duration_millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareContext {
    pub operating_system: &'static str,
    pub architecture: &'static str,
    pub os_version: Option<String>,
    pub model: Option<String>,
    pub cpu: Option<String>,
    pub memory_bytes: Option<u64>,
}

pub fn hardware_context() -> HardwareContext {
    #[cfg(target_os = "macos")]
    let context = HardwareContext {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        os_version: command_value("sw_vers", &["-productVersion"]),
        model: command_value("sysctl", &["-n", "hw.model"]),
        cpu: command_value("sysctl", &["-n", "machdep.cpu.brand_string"]),
        memory_bytes: command_value("sysctl", &["-n", "hw.memsize"])
            .and_then(|value| value.parse().ok()),
    };
    #[cfg(not(target_os = "macos"))]
    let context = HardwareContext {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        os_version: command_value("uname", &["-sr"]),
        model: None,
        cpu: None,
        memory_bytes: None,
    };
    context
}

fn command_value(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
pub fn process_memory_method() -> &'static str {
    "proc_pid_rusage RUSAGE_INFO_V4 attributed physical footprint + resident bytes; proc_pidinfo PROC_PIDLISTFDS"
}

#[cfg(target_os = "linux")]
pub fn process_memory_method() -> &'static str {
    "/proc status/stat/fd; physical footprint unavailable"
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_memory_method() -> &'static str {
    "ps RSS fallback; physical footprint, CPU wakeups, and descriptors unavailable"
}
