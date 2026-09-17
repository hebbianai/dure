//! 시스템 자원 표본 — 상태 표시줄 '자원 관리자' 위젯이 읽는 유일한 출처.
//!
//! CPU는 두 표본 사이의 차이라, `System`을 프로세스 수명 동안 살려 둔다.
//! 매번 새로 만들면 첫 표본에는 비교 대상이 없어 0%나 100%가 나온다.
//!
//! 디스크는 워크스페이스 폴더의 크기(`du`)가 아니라 그 폴더가 놓인 볼륨의
//! 여유/전체 용량이다. 폴더 크기는 큰 저장소에서 수 초가 걸려 상태 표시줄이
//! 매 갱신마다 디스크를 훑게 되고, 정작 사용자가 알고 싶은 "이 디스크가
//! 얼마나 남았나"는 볼륨 쪽 숫자다.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemResources {
    /// 전체 코어 평균 사용률(0~100).
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    /// 요청한 경로가 놓인 볼륨. 경로를 못 찾으면 가장 긴 마운트가 아니라
    /// 아무 값도 주지 않는다 — 엉뚱한 볼륨의 숫자는 없느니만 못하다.
    pub disk_free_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
}

static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

/// 경로를 담고 있는 마운트 중 가장 긴(=가장 구체적인) 것을 고른다.
/// `/Users/me/x`는 `/`와 `/Users` 양쪽에 매치될 수 있고, 답은 후자다.
fn volume_for(path: &str) -> Option<(u64, u64)> {
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy().into_owned();
        if !path.starts_with(&mount) {
            continue;
        }
        let len = mount.len();
        if best.is_none_or(|(best_len, _, _)| len > best_len) {
            best = Some((len, disk.available_space(), disk.total_space()));
        }
    }
    best.map(|(_, free, total)| (free, total))
}

/// 한 번의 표본. 호출 간격은 호출자(위젯 폴링)가 정한다 — sysinfo는 CPU
/// 갱신 사이에 최소 간격을 권하는데, 위젯은 그보다 훨씬 느리게 부른다.
pub fn sample(path: Option<&str>) -> SystemResources {
    let mut guard = match SYSTEM.lock() {
        Ok(guard) => guard,
        // 표본 하나 때문에 앱을 죽이지 않는다 — 다음 호출이 다시 시도한다.
        Err(poisoned) => poisoned.into_inner(),
    };
    let system = guard.get_or_insert_with(System::new);
    system.refresh_cpu_usage();
    system.refresh_memory();
    let cpu_percent = system.global_cpu_usage();
    let memory_used_bytes = system.used_memory();
    let memory_total_bytes = system.total_memory();
    drop(guard);

    let (disk_free_bytes, disk_total_bytes) = match path.and_then(volume_for) {
        Some((free, total)) => (Some(free), Some(total)),
        None => (None, None),
    };
    SystemResources {
        cpu_percent,
        memory_used_bytes,
        memory_total_bytes,
        disk_free_bytes,
        disk_total_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_reports_memory_and_bounded_cpu() {
        let first = sample(None);
        assert!(first.memory_total_bytes > 0);
        assert!(first.memory_used_bytes <= first.memory_total_bytes);
        // 첫 표본은 비교 대상이 없어 0일 수 있지만 범위는 지켜야 한다.
        assert!((0.0..=100.0 * num_cpus_upper_bound()).contains(&first.cpu_percent));
    }

    #[test]
    fn unknown_path_yields_no_disk_numbers() {
        // 존재하지 않는 마운트에 대해 아무 볼륨이나 고르면 안 된다.
        let sampled = sample(Some("\u{0}not-a-path"));
        assert!(sampled.disk_free_bytes.is_none());
        assert!(sampled.disk_total_bytes.is_none());
    }

    /// global_cpu_usage는 0~100이지만, 플랫폼에 따라 합산 값이 잠깐
    /// 넘칠 수 있어 상한을 넉넉히 둔다.
    fn num_cpus_upper_bound() -> f32 {
        2.0
    }
}
