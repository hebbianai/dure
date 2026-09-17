use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHardwareProfile {
    logical_cores: Option<usize>,
    physical_memory_bytes: Option<u64>,
}

pub fn current() -> SystemHardwareProfile {
    SystemHardwareProfile {
        logical_cores: std::thread::available_parallelism()
            .ok()
            .map(std::num::NonZeroUsize::get),
        physical_memory_bytes: physical_memory_bytes(),
    }
}

#[cfg(target_os = "macos")]
fn physical_memory_bytes() -> Option<u64> {
    let mut bytes = 0_u64;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: `hw.memsize` writes one u64 into `bytes`; both output pointers
    // remain valid for the duration of the call and no input buffer is used.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && size == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
}

#[cfg(not(target_os = "macos"))]
fn physical_memory_bytes() -> Option<u64> {
    None
}

#[tauri::command]
pub fn system_hardware_profile() -> SystemHardwareProfile {
    current()
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_profile_reports_positive_available_capacity() {
        let profile = super::current();
        if let Some(logical_cores) = profile.logical_cores {
            assert!(logical_cores > 0);
        }
        if let Some(physical_memory_bytes) = profile.physical_memory_bytes {
            assert!(physical_memory_bytes > 0);
        }
        #[cfg(target_os = "macos")]
        assert!(profile.physical_memory_bytes.is_some());
    }
}
