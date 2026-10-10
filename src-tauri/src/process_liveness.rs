/// Returns true only when the OS proves that no process currently owns `pid`.
/// A successful probe or any error other than ESRCH stays fail-closed because
/// the PID may be live, inaccessible, or reused by another generation.
#[cfg(unix)]
pub(crate) fn definitely_dead(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 || unsafe { libc::kill(pid, 0) } != -1 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
pub(crate) fn definitely_dead(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => handle,
        Err(error) => {
            return error.code() == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0);
        }
    };
    let mut code = STILL_ACTIVE.0 as u32;
    let observed = unsafe { GetExitCodeProcess(handle, &mut code) };
    let _ = unsafe { CloseHandle(handle) };
    observed.is_ok() && code != STILL_ACTIVE.0 as u32
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn definitely_dead(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn current_and_invalid_zero_pid_are_not_proven_dead() {
        assert!(!super::definitely_dead(std::process::id()));
        assert!(!super::definitely_dead(0));
    }
}
