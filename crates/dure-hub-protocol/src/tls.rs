//! 읽기와 쓰기가 동시에 필요한 인증 완료 TLS 스트림.
//!
//! `rustls::StreamOwned`는 `&mut self` 하나로 읽고 쓴다. 터미널은 출력 읽기와 입력
//! 쓰기가 서로를 기다리면 안 되므로, 암호 상태만 짧게 잠그고 소켓 읽기는 잠금
//! 밖에서 기다린다. 인증서·토큰 판단은 이 모듈에 없다.

use rustls::{Connection, StreamOwned};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::ops::Range;
use std::sync::{Arc, Mutex, MutexGuard};

struct Shared {
    connection: Mutex<Connection>,
}

pub struct TlsReader {
    shared: Arc<Shared>,
    socket: TcpStream,
    response_socket: TcpStream,
    encrypted: [u8; 16 * 1024],
    unread_encrypted: Range<usize>,
    pending: Option<u8>,
    eof: bool,
}

pub struct TlsWriter {
    shared: Arc<Shared>,
    socket: TcpStream,
}

pub struct TlsInterrupt {
    socket: TcpStream,
}

fn lock(shared: &Shared) -> MutexGuard<'_, Connection> {
    shared
        .connection
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn flush_tls(connection: &mut Connection, socket: &mut TcpStream) -> io::Result<()> {
    while connection.wants_write() {
        if connection.write_tls(socket)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "TLS 레코드를 쓰지 못했습니다",
            ));
        }
    }
    Ok(())
}

/// 이미 핸드셰이크와 Hub 인증을 마친 스트림을 동시 읽기/쓰기로 나눈다.
pub fn split<C>(
    stream: StreamOwned<C, TcpStream>,
) -> io::Result<(TlsReader, TlsWriter, TlsInterrupt)>
where
    C: Into<Connection>,
{
    let StreamOwned {
        conn: connection,
        sock: socket,
    } = stream;
    socket.set_read_timeout(None)?;
    socket.set_write_timeout(None)?;
    let reader_socket = socket.try_clone()?;
    let response_socket = socket.try_clone()?;
    let interrupt_socket = socket.try_clone()?;
    let shared = Arc::new(Shared {
        connection: Mutex::new(connection.into()),
    });
    Ok((
        TlsReader {
            shared: Arc::clone(&shared),
            socket: reader_socket,
            response_socket,
            encrypted: [0; 16 * 1024],
            unread_encrypted: 0..0,
            pending: None,
            eof: false,
        },
        TlsWriter { shared, socket },
        TlsInterrupt {
            socket: interrupt_socket,
        },
    ))
}

impl TlsReader {
    pub fn set_read_timeout(&self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        self.socket.set_read_timeout(timeout)
    }

    /// 암호화된 바이트가 도착했는지 본다. 평문을 소비하지 않는다.
    pub fn wait_readable(&mut self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        if self.pending.is_some() || self.eof {
            return Ok(());
        }
        self.socket.set_read_timeout(timeout)?;
        let mut byte = [0_u8; 1];
        let outcome = self.read(&mut byte);
        let _ = self.socket.set_read_timeout(None);
        match outcome {
            Ok(0) => {
                self.eof = true;
                Ok(())
            }
            Ok(_) => {
                self.pending = Some(byte[0]);
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl Read for TlsReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if let Some(byte) = self.pending.take() {
            output[0] = byte;
            return Ok(1);
        }
        if self.eof {
            return Ok(0);
        }
        loop {
            {
                let mut connection = lock(&self.shared);
                match connection.reader().read(output) {
                    Ok(read) if read > 0 => return Ok(read),
                    Ok(_) => return Ok(0),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error),
                }
            }

            if self.unread_encrypted.is_empty() {
                let read = self.socket.read(&mut self.encrypted)?;
                self.unread_encrypted = 0..read;
            }
            let mut connection = lock(&self.shared);
            let mut encrypted = &self.encrypted[self.unread_encrypted.clone()];
            let accepted = connection.read_tls(&mut encrypted)?;
            if !self.unread_encrypted.is_empty() && accepted == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "TLS 입력을 받아들이지 못했습니다",
                ));
            }
            self.unread_encrypted.start += accepted;
            connection
                .process_new_packets()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            flush_tls(&mut connection, &mut self.response_socket)?;
            if accepted == 0 {
                let outcome = connection.reader().read(output);
                if matches!(outcome, Ok(0)) {
                    self.eof = true;
                }
                return outcome;
            }
            // Drain plaintext before feeding rustls again. A socket batch can
            // finish a partial record and exceed plaintext backpressure while
            // still holding ciphertext; retain that suffix across Read calls.
        }
    }
}

impl TlsWriter {
    pub fn set_write_timeout(&self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        self.socket.set_write_timeout(timeout)
    }

    pub fn close(&mut self) -> io::Result<()> {
        let mut connection = lock(&self.shared);
        connection.send_close_notify();
        flush_tls(&mut connection, &mut self.socket)
    }
}

impl Write for TlsWriter {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let mut connection = lock(&self.shared);
        flush_tls(&mut connection, &mut self.socket)?;
        let written = connection.writer().write(input)?;
        flush_tls(&mut connection, &mut self.socket)?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut connection = lock(&self.shared);
        connection.writer().flush()?;
        flush_tls(&mut connection, &mut self.socket)
    }
}

impl TlsInterrupt {
    pub fn interrupt(&self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}
