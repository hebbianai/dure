use hmux_host::local_protocol::{ErrorCode, FrameBody, FrameCodec, RetryPosture};
use hmux_host::session_host::SessionHost;
use hmux_host::terminal_replay::ViewProjection;

use crate::host_resource_budget::RetainedActiveConnection;
use crate::subscriber_delivery::{PreparedFrame, SubscriberDelivery};
use crate::{Result, ServerState};

use super::protocol::write_error;
use super::transport::SharedFrameWriter;

pub(crate) struct PreparedTerminalViewport {
    projection: ViewProjection,
    active_connection: RetainedActiveConnection,
    records: (Vec<Vec<u8>>, Option<String>),
}

pub(crate) struct SeededTerminalViewport {
    pub(crate) projection: ViewProjection,
    pub(crate) active_connection: RetainedActiveConnection,
    pub(crate) publication_generation: u64,
}

pub(crate) fn prepare_terminal_viewport(
    state: &ServerState,
    host: &mut SessionHost,
    terminal_base_protocol_minor: u8,
    terminal_viewport_multipart: bool,
    active_connection: RetainedActiveConnection,
) -> Result<PreparedTerminalViewport> {
    let mut projection = host.attach_view_projection(&state.fence)?;
    let initial = state.capture_initial_attachment_viewport(host, &mut projection)?;
    let records = ServerState::prepare_structured_batch(
        initial,
        terminal_base_protocol_minor,
        terminal_viewport_multipart,
    )?;
    Ok(PreparedTerminalViewport {
        projection,
        active_connection,
        records,
    })
}

pub(crate) fn seed_terminal_delivery(
    state: &ServerState,
    delivery: &SubscriberDelivery,
    semantic_seeds: [Option<FrameBody>; 4],
    viewport: Option<PreparedTerminalViewport>,
) -> Result<Option<SeededTerminalViewport>> {
    for body in semantic_seeds.into_iter().flatten() {
        let mut frame = PreparedFrame::new(body);
        if !delivery.deliver(&mut frame) {
            return Err("Hmux semantic seed queue is unavailable".into());
        }
    }
    let Some(viewport) = viewport else {
        return Ok(None);
    };
    let batch = state.sequence_prepared_structured_batch(viewport.records)?;
    if !delivery.deliver_viewport(&batch) {
        return Err("Hmux terminal viewport seed queue is unavailable".into());
    }
    let publication_generation = state
        .viewport_publication
        .current_generation()
        .ok_or("terminal viewport publication is unavailable")?;
    Ok(Some(SeededTerminalViewport {
        projection: viewport.projection,
        active_connection: viewport.active_connection,
        publication_generation,
    }))
}

pub(crate) fn refuse_terminal_viewport_attach(
    codec: &FrameCodec,
    writer: &SharedFrameWriter,
    phase: &str,
    error: impl std::fmt::Display,
) -> Result<()> {
    write_error(
        codec,
        writer,
        ErrorCode::TransportClosed,
        &format!("Hmux could not {phase} the initial terminal viewport: {error}"),
        RetryPosture::Reconnect,
    )
}
