use std::io;
use std::os::fd::RawFd;

/// Reduce a freshly exec'd broker to its stdin/stdout/stderr contract.
pub(crate) fn close_all() -> io::Result<()> {
    for descriptor in open_descriptors()? {
        if descriptor <= libc::STDERR_FILENO {
            continue;
        }
        // SAFETY: the process has already exec'd and the broker contract owns
        // no descriptor above stderr.
        if unsafe { libc::close(descriptor) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EBADF) {
                return Err(io::Error::new(
                    error.kind(),
                    format!("could not close inherited broker descriptor {descriptor}: {error}"),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_vendor = "apple")]
fn open_descriptors() -> io::Result<Vec<RawFd>> {
    use std::mem::{self, MaybeUninit};

    let pid = i32::try_from(std::process::id())
        .map_err(|_| io::Error::other("broker process id does not fit pid_t"))?;
    let record_size = mem::size_of::<libc::proc_fdinfo>();
    let mut capacity = 64_usize;
    loop {
        let mut records = (0..capacity)
            .map(|_| MaybeUninit::<libc::proc_fdinfo>::uninit())
            .collect::<Vec<_>>();
        let buffer_bytes = capacity
            .checked_mul(record_size)
            .and_then(|size| i32::try_from(size).ok())
            .ok_or_else(|| io::Error::other("broker descriptor census exceeded platform bounds"))?;
        // SAFETY: records is writable for buffer_bytes and proc_pidinfo
        // reports how many complete bytes it initialized.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                records.as_mut_ptr().cast(),
                buffer_bytes,
            )
        };
        if written <= 0 {
            return Err(io::Error::last_os_error());
        }
        let written = written as usize;
        if written % record_size != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "broker descriptor census returned a partial record",
            ));
        }
        let count = written / record_size;
        if count < capacity {
            return Ok(records
                .into_iter()
                .take(count)
                .map(|record| {
                    // SAFETY: proc_pidinfo initialized the first count records.
                    unsafe { record.assume_init().proc_fd }
                })
                .collect());
        }
        capacity = capacity
            .checked_mul(2)
            .ok_or_else(|| io::Error::other("broker descriptor census capacity overflow"))?;
    }
}

#[cfg(target_os = "linux")]
fn open_descriptors() -> io::Result<Vec<RawFd>> {
    std::fs::read_dir("/proc/self/fd")?
        .map(|entry| {
            let entry = entry?;
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<RawFd>().ok())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "broker descriptor census returned a non-numeric entry",
                    )
                })
        })
        .collect()
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
fn open_descriptors() -> io::Result<std::ops::Range<RawFd>> {
    // SAFETY: sysconf only reads the process descriptor limit.
    let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    if maximum <= libc::STDERR_FILENO.into() {
        return Err(io::Error::other(
            "broker descriptor limit is unavailable",
        ));
    }
    let maximum = RawFd::try_from(maximum)
        .map_err(|_| io::Error::other("broker descriptor limit does not fit RawFd"))?;
    Ok(libc::STDERR_FILENO + 1..maximum)
}
