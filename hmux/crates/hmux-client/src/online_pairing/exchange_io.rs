//! Bounded line I/O shared by the phone and the pairing listener.

use super::pairing_time_remaining;
use std::io::{self, BufRead as _, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

fn remaining(deadline: Instant) -> io::Result<Duration> {
    pairing_time_remaining(deadline).map_err(|code| io::Error::new(io::ErrorKind::TimedOut, code))
}

/// Reads one bounded JSON line. Arriving bytes cannot reset the deadline.
pub fn read_line(stream: &TcpStream, deadline: Instant, limit: usize) -> io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    BufReader::new(DeadlineSocket { stream, deadline })
        .take(limit as u64)
        .read_until(b'\n', &mut raw)?;
    remaining(deadline)?;
    Ok(raw)
}

/// Sends an already encoded document, including its trailing newline.
pub fn write_all(stream: &TcpStream, deadline: Instant, bytes: &[u8]) -> io::Result<()> {
    DeadlineSocket { stream, deadline }.write_all(bytes)
}

struct DeadlineSocket<'a> {
    stream: &'a TcpStream,
    deadline: Instant,
}

impl Read for DeadlineSocket<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.stream
            .set_read_timeout(Some(remaining(self.deadline)?))?;
        self.stream.read(buffer)
    }
}

impl Write for DeadlineSocket<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream
            .set_write_timeout(Some(remaining(self.deadline)?))?;
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
