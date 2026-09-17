//! One verified client carrier after platform-local admission.

use hmux_host::local_transport::{FrameReader, FrameWriter, TransportInterrupt};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
use hmux_local_platform::transport::fd::{FdFrameReader, SocketInterrupt, UnixSocketFrameWriter};
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::net::UnixStream;

pub(crate) type SharedFrameWriter = Arc<Mutex<Box<dyn FrameWriter>>>;

pub(crate) fn shared_frame_writer(writer: impl FrameWriter + 'static) -> SharedFrameWriter {
    Arc::new(Mutex::new(Box::new(writer)))
}

pub(crate) struct ClientTransport {
    reader: Box<dyn FrameReader>,
    writer: SharedFrameWriter,
    interrupt: Arc<dyn TransportInterrupt>,
}

impl ClientTransport {
    pub(crate) fn new(
        reader: impl FrameReader + 'static,
        writer: impl FrameWriter + 'static,
        interrupt: Arc<dyn TransportInterrupt>,
    ) -> Self {
        Self {
            reader: Box::new(reader),
            writer: shared_frame_writer(writer),
            interrupt,
        }
    }

    /// Splits the exact Unix socket that already passed kernel peer
    /// verification into independent reader, writer, and cancellation
    /// capabilities.
    #[cfg(unix)]
    pub(crate) fn from_verified_unix_socket(stream: UnixStream) -> io::Result<Self> {
        let writer = stream.try_clone()?;
        let interrupt = stream.try_clone()?;
        Ok(Self::new(
            FdFrameReader::new(stream),
            UnixSocketFrameWriter::new(writer),
            Arc::new(SocketInterrupt::new(interrupt)),
        ))
    }

    pub(crate) fn reader(&mut self) -> &mut dyn FrameReader {
        &mut *self.reader
    }

    pub(crate) fn writer(&self) -> SharedFrameWriter {
        Arc::clone(&self.writer)
    }

    pub(crate) fn interrupt_handle(&self) -> Arc<dyn TransportInterrupt> {
        Arc::clone(&self.interrupt)
    }

    pub(crate) fn interrupt(&self) {
        self.interrupt.interrupt();
    }
}
