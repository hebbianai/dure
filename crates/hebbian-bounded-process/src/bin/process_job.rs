#[cfg(windows)]
mod windows {
    use hebbian_bounded_process::windows_job::WindowsJob;
    use std::ffi::OsStr;
    use std::io::{self, Write};
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, INFINITE, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE, WaitForMultipleObjects, WaitForSingleObject,
    };

    const RETIREMENT_TIMEOUT: Duration = Duration::from_secs(30);
    const WINDOWS_EPOCH_MICROSECONDS: u64 = 11_644_473_600_000_000;

    struct Generation {
        pid: u32,
        started: u64,
    }

    fn invalid(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    impl Generation {
        fn parse(value: &str) -> io::Result<Self> {
            let mut parts = value.split(':');
            if parts.next() != Some("windows") {
                return Err(invalid("invalid Windows process generation"));
            }
            let pid = parts.next().and_then(|v| v.parse().ok()).filter(|v| *v > 0);
            let started = parts.next().and_then(|v| v.parse().ok()).filter(|v| *v > 0);
            match (pid, started, parts.next()) {
                (Some(pid), Some(started), None) => Ok(Self { pid, started }),
                _ => Err(invalid("invalid Windows process generation")),
            }
        }

        fn open(&self, access: u32) -> io::Result<Option<OwnedHandle>> {
            let raw = unsafe {
                OpenProcess(
                    access | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    self.pid,
                )
            };
            if raw.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            if started_at(raw)? != self.started {
                return Ok(None);
            }
            match unsafe { WaitForSingleObject(raw, 0) } {
                WAIT_TIMEOUT => Ok(Some(handle)),
                WAIT_OBJECT_0 => Ok(None),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    fn started_at(process: RawHandle) -> io::Result<u64> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        (ticks / 10)
            .checked_sub(WINDOWS_EPOCH_MICROSECONDS)
            .ok_or_else(|| invalid("invalid Windows creation time"))
    }

    fn job_name(key: &str) -> io::Result<String> {
        if key.len() != 64
            || !key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid Job capability"));
        }
        Ok(format!("Local\\dure-process-job-{key}"))
    }

    fn lease(key: &str, leader: &str, owner: &str) -> io::Result<()> {
        let name = job_name(key)?;
        let leader = Generation::parse(leader)?
            .open(PROCESS_SET_QUOTA | PROCESS_TERMINATE)?
            .ok_or_else(|| invalid("launch generation retired before Job admission"))?;
        let owner = Generation::parse(owner)?
            .open(0)?
            .ok_or_else(|| invalid("owner generation retired before Job admission"))?;
        let job = WindowsJob::create(Some(OsStr::new(&name)))?;
        job.assign(leader.as_handle())?;
        let pid = std::process::id();
        let started = started_at(unsafe { GetCurrentProcess() })?;
        println!(
            "{{\"protocolVersion\":1,\"type\":\"windows_job_ready\",\"jobId\":\"{key}\",\"witness\":{{\"pid\":{pid},\"processIdentity\":\"windows:{pid}:{started}\"}}}}"
        );
        io::stdout().flush()?;

        // Retain both kernel process handles. PID reuse cannot retarget this lease.
        let handles = [leader.as_raw_handle(), owner.as_raw_handle()];
        let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        if result != WAIT_OBJECT_0 && result != WAIT_OBJECT_0 + 1 {
            return Err(io::Error::last_os_error());
        }
        job.terminate(1)?;
        job.wait_empty(RETIREMENT_TIMEOUT)
    }

    fn observe(key: &str, leader: &str, witness: &str) -> io::Result<()> {
        let name = job_name(key)?;
        let Some(job) = WindowsJob::open(OsStr::new(&name))? else {
            println!("{{\"state\":\"retired\"}}");
            return Ok(());
        };
        if job.is_empty()? {
            println!("{{\"state\":\"retired\"}}");
        } else {
            let leader = Generation::parse(leader)?.open(0)?.is_some();
            let witness = Generation::parse(witness)?.open(0)?.is_some();
            println!(
                "{{\"state\":\"owned\",\"leaderCurrent\":{leader},\"witnessCurrent\":{witness}}}"
            );
        }
        Ok(())
    }

    fn terminate(key: &str) -> io::Result<()> {
        let name = job_name(key)?;
        if let Some(job) = WindowsJob::open(OsStr::new(&name))? {
            job.terminate(1)?;
            job.wait_empty(RETIREMENT_TIMEOUT)?;
        }
        println!("{{\"state\":\"retired\"}}");
        Ok(())
    }

    pub fn run() -> io::Result<()> {
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        match arguments
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["--version"] => {
                println!("{{\"protocolVersion\":1,\"type\":\"windows_job_runtime\"}}");
                Ok(())
            }
            ["lease", key, leader, owner] => lease(key, leader, owner),
            ["observe", key, leader, witness] => observe(key, leader, witness),
            ["terminate", key] => terminate(key),
            _ => Err(invalid("expected --version, lease, observe or terminate")),
        }
    }
}

fn main() {
    #[cfg(windows)]
    if let Err(error) = windows::run() {
        eprintln!("Windows process Job: {error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Windows process Job requires Windows");
        std::process::exit(1);
    }
}
