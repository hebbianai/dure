use std::{
    thread,
    time::{Duration, Instant},
};

const IO_CHUNK_BYTES: usize = 32 * 1024;
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(2);
const OUTPUT_LIMIT_ERROR: &str = "ssh_exec_output_limit";
const TIMEOUT_ERROR: &str = "ssh_exec_timeout";

pub(super) enum Step<T> {
    Ready(T),
    Pending,
}

pub(super) trait Channel {
    fn write_stdin(&mut self, bytes: &[u8]) -> Result<Step<usize>, String>;
    fn send_eof(&mut self) -> Result<Step<()>, String>;
    fn read_stdout(&mut self, bytes: &mut [u8]) -> Result<Step<usize>, String>;
    fn read_stderr(&mut self, bytes: &mut [u8]) -> Result<Step<usize>, String>;
    fn close(&mut self) -> Result<Step<()>, String>;
    fn wait_close(&mut self) -> Result<Step<()>, String>;
    fn exit_status(&self) -> i32;
}

#[derive(Debug)]
pub(super) struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

pub(super) fn execute(
    channel: &mut impl Channel,
    stdin: &[u8],
    output_limit: usize,
    deadline: Instant,
) -> Result<Output, String> {
    let exchanged = exchange(channel, stdin, output_limit, deadline);
    let completed = complete(channel, deadline);
    let (stdout, stderr) = exchanged?;
    completed?;
    Ok(Output {
        stdout,
        stderr,
        code: channel.exit_status(),
    })
}

fn complete(channel: &mut impl Channel, deadline: Instant) -> Result<(), String> {
    drive_until_ready(|| channel.close(), deadline)?;
    drive_until_ready(|| channel.wait_close(), deadline)
}

fn drive_until_ready(
    mut step: impl FnMut() -> Result<Step<()>, String>,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        match step()? {
            Step::Ready(()) => return Ok(()),
            Step::Pending if Instant::now() >= deadline => {
                return Err(TIMEOUT_ERROR.to_string());
            }
            Step::Pending => thread::sleep(IDLE_POLL_INTERVAL),
        }
    }
}

fn exchange(
    channel: &mut impl Channel,
    stdin: &[u8],
    output_limit: usize,
    deadline: Instant,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut stdin_offset = 0;
    let mut eof_sent = false;
    let mut stdout = Vec::with_capacity(output_limit.min(8 * 1024));
    let mut stderr = Vec::with_capacity(output_limit.min(8 * 1024));
    let mut stdout_done = false;
    let mut stderr_done = false;

    loop {
        let mut progressed = false;
        if stdin_offset < stdin.len() {
            let end = stdin_offset.saturating_add(IO_CHUNK_BYTES).min(stdin.len());
            let pending = &stdin[stdin_offset..end];
            match channel.write_stdin(pending)? {
                Step::Ready(0) => return Err("ssh_exec_stdin_closed".to_string()),
                Step::Ready(written) if written <= pending.len() => {
                    stdin_offset += written;
                    progressed = true;
                }
                Step::Ready(_) => return Err("ssh_exec_invalid_write_receipt".to_string()),
                Step::Pending => {}
            }
        }
        if stdin_offset == stdin.len() && !eof_sent {
            match channel.send_eof()? {
                Step::Ready(()) => {
                    eof_sent = true;
                    progressed = true;
                }
                Step::Pending => {}
            }
        }

        if !stdout_done {
            let (read_progressed, done) = poll_stream(
                |buffer| channel.read_stdout(buffer),
                &mut stdout,
                stderr.len(),
                output_limit,
            )?;
            progressed |= read_progressed;
            stdout_done = done;
        }
        if !stderr_done {
            let (read_progressed, done) = poll_stream(
                |buffer| channel.read_stderr(buffer),
                &mut stderr,
                stdout.len(),
                output_limit,
            )?;
            progressed |= read_progressed;
            stderr_done = done;
        }

        if eof_sent && stdout_done && stderr_done {
            return Ok((stdout, stderr));
        }
        if Instant::now() >= deadline {
            return Err(TIMEOUT_ERROR.to_string());
        }
        if !progressed {
            thread::sleep(IDLE_POLL_INTERVAL);
        }
    }
}

fn poll_stream(
    read: impl FnOnce(&mut [u8]) -> Result<Step<usize>, String>,
    captured: &mut Vec<u8>,
    other_stream_bytes: usize,
    output_limit: usize,
) -> Result<(bool, bool), String> {
    let total = captured.len().saturating_add(other_stream_bytes);
    let available = output_limit.saturating_sub(total).saturating_add(1);
    let mut buffer = [0_u8; IO_CHUNK_BYTES];
    let buffer = &mut buffer[..available.min(IO_CHUNK_BYTES)];
    match read(buffer)? {
        Step::Ready(0) => Ok((true, true)),
        Step::Ready(read) if read <= buffer.len() => {
            if total.saturating_add(read) > output_limit {
                return Err(OUTPUT_LIMIT_ERROR.to_string());
            }
            captured.extend_from_slice(&buffer[..read]);
            Ok((true, false))
        }
        Step::Ready(_) => Err("ssh_exec_invalid_read_receipt".to_string()),
        Step::Pending => Ok((false, false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct ProbeChannel {
        stdin: Vec<u8>,
        stdout: VecDeque<u8>,
        stderr: VecDeque<u8>,
        eof_sent: bool,
        close_count: usize,
        wait_close_count: usize,
        write_window: usize,
        refill_write_window: bool,
        pending_writes: usize,
        pending_closes: usize,
        never_ready: bool,
    }

    impl ProbeChannel {
        fn new(stdout: &[u8], stderr: &[u8]) -> Self {
            Self {
                stdin: Vec::new(),
                stdout: stdout.iter().copied().collect(),
                stderr: stderr.iter().copied().collect(),
                eof_sent: false,
                close_count: 0,
                wait_close_count: 0,
                write_window: usize::MAX,
                refill_write_window: false,
                pending_writes: 0,
                pending_closes: 0,
                never_ready: false,
            }
        }

        fn read_stream(&mut self, stderr: bool, buffer: &mut [u8]) -> Step<usize> {
            if self.never_ready {
                return Step::Pending;
            }
            let stream = if stderr {
                &mut self.stderr
            } else {
                &mut self.stdout
            };
            if stream.is_empty() {
                return if self.eof_sent {
                    Step::Ready(0)
                } else {
                    Step::Pending
                };
            }
            let read = buffer.len().min(stream.len());
            for destination in &mut buffer[..read] {
                *destination = stream
                    .pop_front()
                    .expect("bounded stream length was observed");
            }
            if self.refill_write_window {
                self.write_window = self.write_window.saturating_add(read);
            }
            Step::Ready(read)
        }
    }

    impl Channel for ProbeChannel {
        fn write_stdin(&mut self, bytes: &[u8]) -> Result<Step<usize>, String> {
            if self.pending_writes > 0 {
                self.pending_writes -= 1;
                return Ok(Step::Pending);
            }
            if self.never_ready || self.write_window == 0 {
                return Ok(Step::Pending);
            }
            let written = bytes.len().min(self.write_window);
            self.stdin.extend_from_slice(&bytes[..written]);
            self.write_window = self.write_window.saturating_sub(written);
            Ok(Step::Ready(written))
        }

        fn send_eof(&mut self) -> Result<Step<()>, String> {
            if self.never_ready {
                return Ok(Step::Pending);
            }
            self.eof_sent = true;
            Ok(Step::Ready(()))
        }

        fn read_stdout(&mut self, bytes: &mut [u8]) -> Result<Step<usize>, String> {
            Ok(self.read_stream(false, bytes))
        }

        fn read_stderr(&mut self, bytes: &mut [u8]) -> Result<Step<usize>, String> {
            Ok(self.read_stream(true, bytes))
        }

        fn close(&mut self) -> Result<Step<()>, String> {
            self.close_count += 1;
            if self.never_ready || self.pending_closes > 0 {
                self.pending_closes = self.pending_closes.saturating_sub(1);
                return Ok(Step::Pending);
            }
            Ok(Step::Ready(()))
        }

        fn wait_close(&mut self) -> Result<Step<()>, String> {
            self.wait_close_count += 1;
            Ok(Step::Ready(()))
        }

        fn exit_status(&self) -> i32 {
            0
        }
    }

    fn future_deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[test]
    fn accepts_combined_output_at_the_exact_limit() {
        let mut channel = ProbeChannel::new(b"abc", b"de");

        let output = execute(&mut channel, &[], 5, future_deadline()).unwrap();

        assert_eq!(output.stdout, b"abc");
        assert_eq!(output.stderr, b"de");
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn exec_stdin_converges_after_transient_backpressure() {
        let mut channel = ProbeChannel::new(b"", b"");
        channel.pending_writes = 1;
        let stdin = b"first\0second\n";

        execute(&mut channel, stdin, 32, future_deadline()).unwrap();

        assert_eq!(channel.stdin, stdin);
        assert!(channel.eof_sent);
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn bounds_stdout_and_finishes_the_channel_on_overflow() {
        let mut channel = ProbeChannel::new(b"abcde", b"");

        let error = execute(&mut channel, &[], 4, future_deadline()).unwrap_err();

        assert_eq!(error, OUTPUT_LIMIT_ERROR);
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn bounds_stderr_and_finishes_the_channel_on_overflow() {
        let mut channel = ProbeChannel::new(b"", b"abcde");

        let error = execute(&mut channel, &[], 4, future_deadline()).unwrap_err();

        assert_eq!(error, OUTPUT_LIMIT_ERROR);
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn pumps_large_stdin_stdout_and_stderr_without_window_deadlock() {
        let stdin = vec![b'i'; 2 * 1024 * 1024 + 1];
        let stdout = vec![b'o'; 1024 * 1024 + 1];
        let stderr = vec![b'e'; 1024 * 1024 + 1];
        let mut channel = ProbeChannel::new(&stdout, &stderr);
        channel.write_window = 4096;
        channel.refill_write_window = true;

        let output = execute(&mut channel, &stdin, 3 * 1024 * 1024, future_deadline()).unwrap();

        assert_eq!(channel.stdin, stdin);
        assert_eq!(output.stdout, stdout);
        assert_eq!(output.stderr, stderr);
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn close_converges_after_transient_backpressure() {
        let mut channel = ProbeChannel::new(b"", b"");
        channel.pending_closes = 1;

        execute(&mut channel, &[], 0, future_deadline()).unwrap();

        assert_eq!(channel.close_count, 2);
        assert_eq!(channel.wait_close_count, 1);
    }

    #[test]
    fn deadline_failure_still_finishes_the_channel() {
        let mut channel = ProbeChannel::new(b"", b"");
        channel.never_ready = true;

        let error = execute(&mut channel, b"pending", 8, Instant::now()).unwrap_err();

        assert_eq!(error, TIMEOUT_ERROR);
        assert_eq!(channel.close_count, 1);
        assert_eq!(channel.wait_close_count, 0);
    }
}
