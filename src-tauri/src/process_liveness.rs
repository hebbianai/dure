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

#[cfg(not(unix))]
pub(crate) fn definitely_dead(_pid: u32) -> bool {
    false
}
