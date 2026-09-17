use dure_hub_protocol::tls::{TlsInterrupt, TlsReader, TlsWriter};
use hmux_host::local_protocol::FrameCodec;
use hmux_host::local_transport::{
    drive_read_payload, FrameProgress, FrameReader, FrameWriter, PayloadOutcome, TransportError,
    TransportInterrupt,
};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct HubFrameReader {
    inner: TlsReader,
    completion_timeout: Option<Duration>,
    interrupted: Arc<AtomicBool>,
}

pub struct HubFrameWriter {
    inner: TlsWriter,
    interrupt: Arc<HubInterrupt>,
}

pub struct HubInterrupt {
    inner: TlsInterrupt,
    interrupted: Arc<AtomicBool>,
}

pub fn frame_halves(
    reader: TlsReader,
    writer: TlsWriter,
    interrupt: TlsInterrupt,
) -> (HubFrameReader, HubFrameWriter, Arc<HubInterrupt>) {
    let interrupted = Arc::new(AtomicBool::new(false));
    let interrupt = Arc::new(HubInterrupt {
        inner: interrupt,
        interrupted: Arc::clone(&interrupted),
    });
    (
        HubFrameReader {
            inner: reader,
            completion_timeout: None,
            interrupted,
        },
        HubFrameWriter {
            inner: writer,
            interrupt: Arc::clone(&interrupt),
        },
        interrupt,
    )
}

impl Read for HubFrameReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buffer)
    }
}

impl FrameReader for HubFrameReader {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.inner.wait_readable(timeout).map_err(|error| {
            if self.interrupted.load(Ordering::Acquire) {
                TransportError::Interrupted
            } else if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) {
                TransportError::FirstByteTimeout
            } else {
                TransportError::Io {
                    operation: "wait for Hmux frame over Hub TLS",
                    source: error,
                }
            }
        })
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.inner
            .set_read_timeout(self.completion_timeout)
            .map_err(|source| TransportError::Io {
                operation: "set Hub TLS frame timeout",
                source,
            })?;
        let mut progress = FrameProgress::new();
        let outcome = drive_read_payload(&mut self.inner, &mut progress, codec);
        let _ = self.inner.set_read_timeout(None);
        if self.interrupted.load(Ordering::Acquire) {
            Err(TransportError::Interrupted)
        } else {
            outcome
        }
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }
}

impl FrameWriter for HubFrameWriter {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.write_frame_before(encoded, None)
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        let timeout = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        if timeout.is_some_and(|timeout| timeout.is_zero()) {
            return Err(TransportError::Io {
                operation: "write Hmux frame over Hub TLS",
                source: io::Error::new(io::ErrorKind::TimedOut, "frame deadline elapsed"),
            });
        }
        self.inner
            .set_write_timeout(timeout)
            .and_then(|()| self.inner.write_all(encoded))
            .and_then(|()| self.inner.flush())
            .map_err(|source| {
                self.interrupt.interrupt();
                if matches!(
                    source.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) {
                    TransportError::CompletionTimeout
                } else {
                    TransportError::Io {
                        operation: "write Hmux frame over Hub TLS",
                        source,
                    }
                }
            })
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.inner.close().map_err(|source| TransportError::Io {
            operation: "close Hub TLS write half",
            source,
        })
    }
}

impl TransportInterrupt for HubInterrupt {
    fn interrupt(&self) {
        self.interrupted.store(true, Ordering::Release);
        self.inner.interrupt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
    use std::io::Cursor;
    use std::net::{TcpListener, TcpStream};

    fn tls_pair() -> (
        rustls::StreamOwned<rustls::Connection, TcpStream>,
        rustls::StreamOwned<rustls::Connection, TcpStream>,
    ) {
        let certified =
            rcgen::generate_simple_self_signed(vec!["hub.invalid".to_string()]).unwrap();
        let certificate = CertificateDer::from(certified.cert.der().to_vec());
        let key =
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certified.key_pair.serialize_der()));
        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate).unwrap();
        let client_config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();

        let mut client: rustls::Connection = rustls::ClientConnection::new(
            Arc::new(client_config),
            ServerName::try_from("hub.invalid").unwrap().to_owned(),
        )
        .unwrap()
        .into();
        let mut server: rustls::Connection = rustls::ServerConnection::new(Arc::new(server_config))
            .unwrap()
            .into();
        // Complete the real handshake before the sockets carry deliberately
        // coalesced application records. No timing or TCP segmentation decides
        // how much of the first record is already buffered inside rustls.
        while client.is_handshaking()
            || server.is_handshaking()
            || client.wants_write()
            || server.wants_write()
        {
            receive_tls(&mut server, &take_tls(&mut client));
            receive_tls(&mut client, &take_tls(&mut server));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client_socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server_socket, _) = listener.accept().unwrap();
        (
            rustls::StreamOwned {
                conn: client,
                sock: client_socket,
            },
            rustls::StreamOwned {
                conn: server,
                sock: server_socket,
            },
        )
    }

    fn take_tls(connection: &mut rustls::Connection) -> Vec<u8> {
        let mut encrypted = Vec::new();
        while connection.wants_write() {
            connection.write_tls(&mut encrypted).unwrap();
        }
        encrypted
    }

    fn receive_tls(connection: &mut rustls::Connection, encrypted: &[u8]) {
        let mut cursor = Cursor::new(encrypted);
        while cursor.position() < encrypted.len() as u64 {
            assert!(connection.read_tls(&mut cursor).unwrap() > 0);
            connection.process_new_packets().unwrap();
        }
    }

    #[test]
    fn all_encrypted_bytes_from_one_socket_read_are_preserved() {
        let (client, mut server) = tls_pair();
        let expected = vec![b'x'; 12 * 1024];
        server.conn.writer().write_all(&expected).unwrap();
        server.sock.write_all(&take_tls(&mut server.conn)).unwrap();
        let (mut reader, _, _) = dure_hub_protocol::tls::split(client).unwrap();

        reader.wait_readable(Some(Duration::from_secs(1))).unwrap();
        let mut first = [0_u8; 1];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [b'x']);
        reader
            .wait_readable(Some(Duration::from_millis(100)))
            .unwrap();
        let mut remaining = vec![0_u8; expected.len() - 1];
        reader.read_exact(&mut remaining).unwrap();
        assert_eq!([first.as_slice(), remaining.as_slice()].concat(), expected);
    }

    #[test]
    fn tls_record_boundary_backpressure_preserves_ciphertext_in_both_directions() {
        for server_reads in [false, true] {
            let (client, server) = tls_pair();
            let (mut receiver, mut sender) = if server_reads {
                (server, client)
            } else {
                (client, server)
            };
            let expected: Vec<u8> = (0..24 * 1024).map(|index| (index % 251) as u8).collect();
            // Rustls applies plaintext backpressure above (not at) 16KiB.
            // The short second record crosses that boundary while the third
            // still has ciphertext left in the same socket batch.
            for chunk in [
                &expected[..16 * 1024],
                &expected[16 * 1024..17 * 1024],
                &expected[17 * 1024..],
            ] {
                sender.conn.writer().write_all(chunk).unwrap();
            }
            let encrypted = take_tls(&mut sender.conn);
            let first_record_len =
                5 + usize::from(u16::from_be_bytes([encrypted[3], encrypted[4]]));
            assert!(first_record_len > 16 * 1024);
            assert!(encrypted.len() > first_record_len);
            let second_record_len = 5 + usize::from(u16::from_be_bytes([
                encrypted[first_record_len + 3],
                encrypted[first_record_len + 4],
            ]));
            assert!(encrypted.len() > first_record_len + second_record_len);
            let prefix = first_record_len - 128;
            receive_tls(&mut receiver.conn, &encrypted[..prefix]);
            assert_eq!(
                receiver
                    .conn
                    .process_new_packets()
                    .unwrap()
                    .plaintext_bytes_to_read(),
                0
            );
            let tail = &encrypted[prefix..];
            assert!(tail.len() < 16 * 1024);
            sender.sock.write_all(tail).unwrap();
            // Prove the first record's tail and the later records are
            // queued before the split reader takes its first socket batch.
            let mut peek = vec![0; tail.len()];
            receiver
                .sock
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while receiver.sock.peek(&mut peek).unwrap() != tail.len() {
                assert!(
                    Instant::now() < deadline,
                    "TLS batch did not become readable"
                );
                std::thread::yield_now();
            }
            let (mut reader, _, _) = dure_hub_protocol::tls::split(receiver).unwrap();
            reader.wait_readable(Some(Duration::from_secs(2))).unwrap();
            reader
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut actual = Vec::new();
            let mut small = [0; 31];
            while actual.len() < expected.len() {
                let count = reader.read(&mut small).unwrap();
                assert!(count > 0);
                actual.extend_from_slice(&small[..count]);
            }
            assert_eq!(actual, expected, "server_reads={server_reads}");
            sender.conn.send_close_notify();
            sender.sock.write_all(&take_tls(&mut sender.conn)).unwrap();
            assert_eq!(reader.read(&mut small).unwrap(), 0);
            assert_eq!(reader.read(&mut small).unwrap(), 0);
        }
    }

    #[test]
    fn read_timeout_preserves_later_data_and_abrupt_eof_is_not_clean_close() {
        let (client, mut server) = tls_pair();
        let (mut reader, _, _) = dure_hub_protocol::tls::split(client).unwrap();
        let error = reader
            .wait_readable(Some(Duration::from_millis(20)))
            .unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        server.conn.writer().write_all(b"after timeout").unwrap();
        server.sock.write_all(&take_tls(&mut server.conn)).unwrap();
        reader.wait_readable(Some(Duration::from_secs(2))).unwrap();
        let mut actual = [0; 13];
        reader.read_exact(&mut actual).unwrap();
        assert_eq!(&actual, b"after timeout");
        server.sock.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(
            reader.read(&mut actual).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn waiting_read_does_not_block_writer_and_can_be_interrupted() {
        let (client, server) = tls_pair();
        let (reader, writer, interrupt) = dure_hub_protocol::tls::split(client).unwrap();
        let (mut reader, mut writer, interrupt) = frame_halves(reader, writer, interrupt);
        let (mut peer_reader, _, _) = dure_hub_protocol::tls::split(server).unwrap();
        peer_reader
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (started, start) = std::sync::mpsc::channel();
        let (finished, finish) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            started.send(()).unwrap();
            finished.send(reader.wait_readable(None)).unwrap();
        });
        start.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            finish.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        let (written, write) = std::sync::mpsc::channel();
        let writing = std::thread::spawn(move || {
            written.send(writer.write_frame(b"ping")).unwrap();
        });
        let result = write.recv_timeout(Duration::from_secs(2));
        interrupt.interrupt();
        waiting.join().unwrap();
        writing.join().unwrap();
        result.unwrap().unwrap();
        assert!(matches!(
            finish.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(TransportError::Interrupted)
        ));
        let mut received = [0; 4];
        peer_reader.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"ping");
    }
}
