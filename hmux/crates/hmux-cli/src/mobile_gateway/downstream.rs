use super::{CliError, FrameSink, bounded_refusal_message, lock_sink};
use hmux_client::{
    AttachReplay, ClientError, ConnectionRecord, LocalConnection, TerminalSurfaceAttachment,
};
use hmux_host::local_protocol::FrameBody;
use std::io::Write;
use std::sync::Mutex;

pub(super) fn relay_downstream_body<W: Write>(
    sink: &Mutex<FrameSink<W>>,
    body: FrameBody,
) -> Result<(), CliError> {
    lock_sink(sink)?
        .send(body)
        .map_err(|error| CliError(format!("mobile-gateway could not relay a frame: {error}")))
}

fn relay_downstream_terminal<W: Write>(
    sink: &Mutex<FrameSink<W>>,
    payload: &[u8],
) -> Result<(), CliError> {
    lock_sink(sink)?
        .send_payload(payload)
        .map_err(|error| CliError(format!("mobile-gateway could not relay a frame: {error}")))
}

pub(super) enum GatewayDownstream {
    Control(Box<LocalConnection>),
    Terminal(Box<TerminalSurfaceAttachment>),
}

impl GatewayDownstream {
    pub(super) fn from_connection(connection: LocalConnection) -> Result<Self, CliError> {
        if connection.attach_replay() == &AttachReplay::TerminalViewportFrame {
            return TerminalSurfaceAttachment::from_connection(connection)
                .map(Box::new)
                .map(Self::Terminal)
                .map_err(|error| {
                    CliError(format!(
                        "mobile-gateway could not hydrate the structured downstream: {error}"
                    ))
                });
        }
        Ok(Self::Control(Box::new(connection)))
    }

    fn read_record(&mut self) -> Result<ConnectionRecord, ClientError> {
        match self {
            Self::Control(connection) => connection.read_record(),
            Self::Terminal(surface) => surface.read_delivery_record(),
        }
    }
}

pub(super) fn pump_downstream<W: Write>(
    connection: &mut GatewayDownstream,
    sink: &Mutex<FrameSink<W>>,
) -> Result<(), CliError> {
    loop {
        match connection.read_record() {
            Ok(ConnectionRecord::Control(body)) => {
                relay_downstream_body(sink, *body)?;
            }
            Ok(ConnectionRecord::TerminalState(payload)) => {
                relay_downstream_terminal(sink, &payload)?;
            }
            // An ordinary close, including the one the upstream pump asks for
            // when the relayed client hangs up. Not a failure.
            Err(ClientError::Transport {
                code: "hmux_transport_closed",
                ..
            }) => return Ok(()),
            Err(error) => {
                let host_refusal = matches!(error, ClientError::HostRefused { .. });
                let mut frame = error.to_error_frame();
                frame.message = bounded_refusal_message(&frame.message);
                let _ = relay_downstream_body(sink, FrameBody::Error(frame));
                return if host_refusal {
                    Ok(())
                } else {
                    Err(CliError(format!(
                        "mobile-gateway local stream failed: {}: {error}",
                        error.code()
                    )))
                };
            }
        }
    }
}
