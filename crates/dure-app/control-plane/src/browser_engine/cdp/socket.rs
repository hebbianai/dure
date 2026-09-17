//! Tokio readiness around tungstenite's existing protocol implementation.
//! Keep the WebSocket and its partial frames intact while admitting a bounded
//! capture response on the same session that owns page emulation.

use std::io::{self, Read, Write};
use tokio::{io::Interest, net::TcpStream};
use tokio_tungstenite::tungstenite::{
    Error, Message, WebSocket, client::client_with_config, handshake::HandshakeError,
    protocol::WebSocketConfig,
};

struct ReadyStream {
    stream: TcpStream,
    blocked: Interest,
}

impl ReadyStream {
    async fn ready(&self) -> Result<(), Error> {
        self.stream.ready(self.blocked).await?;
        Ok(())
    }
}

impl Read for ReadyStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.blocked = Interest::READABLE;
        self.stream.try_read(bytes)
    }
}

impl Write for ReadyStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.blocked = Interest::WRITABLE;
        self.stream.try_write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn would_block(error: &Error) -> bool {
    matches!(error, Error::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
}

pub(super) struct Socket(WebSocket<ReadyStream>);

impl Socket {
    pub(super) async fn connect(
        address: &str,
        stream: TcpStream,
        config: WebSocketConfig,
    ) -> Result<Self, Error> {
        let stream = ReadyStream {
            stream,
            blocked: Interest::WRITABLE,
        };
        let mut handshake = client_with_config(address, stream, Some(config));
        loop {
            match handshake {
                Ok((socket, _)) => return Ok(Self(socket)),
                Err(HandshakeError::Failure(error)) => return Err(error),
                Err(HandshakeError::Interrupted(pending)) => {
                    pending.get_ref().get_ref().ready().await?;
                    handshake = pending.handshake();
                }
            }
        }
    }

    pub(super) fn read_limit(&mut self, bytes: usize) -> ReadLimit<'_> {
        let previous = *self.0.get_config();
        self.0.set_config(|config| {
            config.max_frame_size = Some(bytes);
            config.max_message_size = Some(bytes);
        });
        ReadLimit {
            socket: self,
            previous,
        }
    }

    pub(super) async fn send(&mut self, message: Message) -> Result<(), Error> {
        // WouldBlock means tungstenite has already buffered this message.
        // Resume flushing; submitting the message again would duplicate it.
        match self.0.write(message) {
            Ok(()) => {}
            Err(error) if would_block(&error) => {}
            Err(error) => return Err(error),
        }
        loop {
            match self.0.flush() {
                Ok(()) => return Ok(()),
                Err(error) if would_block(&error) => self.0.get_ref().ready().await?,
                Err(error) => return Err(error),
            }
        }
    }

    #[cfg(test)]
    pub(super) async fn next(&mut self) -> Result<Message, Error> {
        loop {
            match self.0.read() {
                Ok(message) => return Ok(message),
                Err(error) if would_block(&error) => self.0.get_ref().ready().await?,
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) fn try_next(&mut self) -> Result<Option<Message>, &'static str> {
        match self.0.read() {
            Ok(message) => Ok(Some(message)),
            Err(error) if would_block(&error) => Ok(None),
            Err(Error::ConnectionClosed | Error::AlreadyClosed) => Err("browser_cdp_disconnected"),
            Err(_) => Err("browser_cdp_read_failed"),
        }
    }

    pub(super) async fn ready(&self) -> Result<(), Error> {
        self.0.get_ref().ready().await
    }
}

pub(super) struct ReadLimit<'a> {
    pub(super) socket: &'a mut Socket,
    previous: WebSocketConfig,
}

impl Drop for ReadLimit<'_> {
    fn drop(&mut self) {
        self.socket.0.set_config(|config| *config = self.previous);
    }
}
