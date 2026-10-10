//! Kernel boot identity for durable local process recovery. Unsupported hosts fail closed.

/// Identifies this kernel boot, independently of wall-clock adjustments.
pub fn local_boot_identity() -> std::io::Result<String> {
    #[cfg(target_os = "macos")]
    let value = {
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        if unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        String::from_utf8(
            buffer
                .get(..size)
                .ok_or_else(|| std::io::Error::other("invalid boot identity"))?
                .to_vec(),
        )
        .map_err(std::io::Error::other)?
    };
    #[cfg(target_os = "linux")]
    let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let value = String::new();
    let value = value.trim_matches(|ch: char| ch == '\0' || ch.is_ascii_whitespace());
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(std::io::Error::other("invalid boot identity"));
    }
    Ok(value.to_ascii_lowercase())
}
