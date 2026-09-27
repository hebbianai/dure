//! Ephemeral evidence from authenticated Hub terminal connections. This observes
//! the existing wire; it neither arbitrates geometry nor rewrites any records.

use hmux_runtime_contract::{
    TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
};
use hmux_session_protocol::{FrameBody, FrameCodec, SessionFence};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use terminal_state_protocol::{decode_record, input_intent, resize_receipt, terminal_state_record};

pub const EVENT: &str = "hub://terminal-widths";
const MAX_PENDING_RESIZES: usize = 32;
const MAX_OBSERVED_FRAME_BYTES: usize = hmux_session_protocol::DEFAULT_MAX_FRAME_BYTES;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub source: &'static str,
    pub host_id: String,
}

impl Route {
    pub fn local() -> Self {
        Self {
            source: "local",
            host_id: "local".into(),
        }
    }

    pub fn remote(host_id: String) -> Self {
        Self {
            source: "ssh",
            host_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Observation {
    pub route: Route,
    pub fence: SessionFence,
    pub columns: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub generation: String,
    pub revision: String,
    pub observations: Vec<Observation>,
}

type Publisher = Arc<dyn Fn(Snapshot) + Send + Sync>;

pub struct TerminalWidths {
    generation: String,
    state: Mutex<Registry>,
    publisher: Mutex<Option<Publisher>>,
}

#[derive(Default)]
struct Registry {
    next_connection: u64,
    revision: u64,
    observations: HashMap<u64, Observation>,
}

impl Default for TerminalWidths {
    fn default() -> Self {
        let mut random = [0_u8; 16];
        // Entropy failure disables observation, never the terminal transport.
        let generation = if getrandom::fill(&mut random).is_ok() {
            random.iter().map(|byte| format!("{byte:02x}")).collect()
        } else {
            String::new()
        };
        Self {
            generation,
            state: Mutex::new(Registry::default()),
            publisher: Mutex::new(None),
        }
    }
}

impl TerminalWidths {
    pub fn set_publisher(&self, publish: Publisher) {
        *self
            .publisher
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(publish);
    }

    fn snapshot_locked(&self, state: &Registry) -> Snapshot {
        Snapshot {
            generation: self.generation.clone(),
            revision: state.revision.to_string(),
            observations: state.observations.values().cloned().collect(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot_locked(&self.state.lock().unwrap_or_else(|error| error.into_inner()))
    }

    fn update(&self, id: u64, observation: Option<Observation>) {
        let snapshot = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.observations.get(&id) == observation.as_ref() {
                return;
            }
            match observation {
                Some(observation) => {
                    state.observations.insert(id, observation);
                }
                None => {
                    state.observations.remove(&id);
                }
            }
            state.revision = state
                .revision
                .checked_add(1)
                .expect("Hub width revision exhausted");
            self.snapshot_locked(&state)
        };
        let publisher = self
            .publisher
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(publish) = publisher {
            publish(snapshot);
        }
    }

    pub fn connect(self: &Arc<Self>, route: Route) -> Arc<ConnectionObserver> {
        let mut registry = self.state.lock().unwrap_or_else(|error| error.into_inner());
        registry.next_connection = registry
            .next_connection
            .checked_add(1)
            .expect("Hub connection ID exhausted");
        Arc::new(ConnectionObserver {
            id: registry.next_connection,
            registry: Arc::clone(self),
            route,
            state: Mutex::new(ConnectionState {
                disabled: self.generation.is_empty(),
                ..Default::default()
            }),
        })
    }
}

#[derive(Default)]
struct ConnectionState {
    disabled: bool,
    fence: Option<SessionFence>,
    requested: Vec<String>,
    verified: bool,
    last_resize_record: u64,
    last_geometry_generation: u64,
    applied_geometry_generation: u64,
    pending: BTreeMap<u64, (u64, u32)>,
}

pub struct ConnectionObserver {
    id: u64,
    registry: Arc<TerminalWidths>,
    route: Route,
    state: Mutex<ConnectionState>,
}

#[derive(Clone, Copy)]
pub enum Direction {
    Upstream,
    Downstream,
}

impl ConnectionObserver {
    fn disable(&self, state: &mut ConnectionState) {
        state.disabled = true;
        state.pending.clear();
        self.registry.update(self.id, None);
    }

    pub fn close(&self) {
        self.disable(&mut self.state.lock().unwrap_or_else(|error| error.into_inner()));
    }

    /// Called before forwarding. The peer cannot answer a resize before its
    /// pending correlation is installed. Only identity/geometry is retained.
    pub fn observe(&self, direction: Direction, framed: &[u8]) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.disabled {
            return;
        }
        let Some(payload) = framed.get(4..) else {
            self.disable(&mut state);
            return;
        };
        if payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC) {
            // Other state records may contain provider text. Do not decode it.
            let relevant = matches!(
                (direction, payload.get(6)),
                (Direction::Upstream, Some(5)) | (Direction::Downstream, Some(11))
            );
            if !relevant {
                return;
            }
            let Ok(decoded) = decode_record(payload) else {
                self.disable(&mut state);
                return;
            };
            if !state.verified
                || state
                    .fence
                    .as_ref()
                    .is_none_or(|fence| fence.terminal_epoch != decoded.record.terminal_epoch)
            {
                self.disable(&mut state);
                return;
            }
            match (direction, decoded.record.body) {
                (Direction::Upstream, Some(terminal_state_record::Body::InputIntent(input))) => {
                    if let Some(input_intent::Intent::Resize(resize)) = input.intent {
                        if decoded.metadata.record_id <= state.last_resize_record
                            || resize.geometry_generation <= state.last_geometry_generation
                        {
                            // A stale proposal cannot replace the last accepted width.
                            return;
                        }
                        if state.pending.len() >= MAX_PENDING_RESIZES {
                            self.disable(&mut state);
                            return;
                        }
                        state.last_resize_record = decoded.metadata.record_id;
                        state.last_geometry_generation = resize.geometry_generation;
                        state.pending.insert(
                            decoded.metadata.record_id,
                            (resize.geometry_generation, resize.columns),
                        );
                    }
                }
                (
                    Direction::Downstream,
                    Some(terminal_state_record::Body::ResizeReceipt(receipt)),
                ) => {
                    let Some((generation, columns)) =
                        state.pending.remove(&receipt.in_reply_to_record_id)
                    else {
                        return;
                    };
                    if matches!(
                        receipt.outcome,
                        Some(resize_receipt::Outcome::AppliedToTerminal(_))
                    ) && generation > state.applied_geometry_generation
                    {
                        state.applied_geometry_generation = generation;
                        self.registry.update(
                            self.id,
                            Some(Observation {
                                route: self.route.clone(),
                                fence: state.fence.clone().expect("verified handshake"),
                                columns,
                            }),
                        );
                    }
                }
                _ => {}
            }
            return;
        }
        let Ok(frame) = FrameCodec::new(Default::default()).decode(framed) else {
            // Future/unknown wire shapes still pass through, without authority
            // inferred from a partial decode.
            self.disable(&mut state);
            return;
        };
        match (direction, frame.body) {
            (Direction::Upstream, FrameBody::Hello(hello)) if state.fence.is_none() => {
                state.fence = Some(hello.expected_fence);
                state.requested = hello.requested_capabilities;
            }
            (Direction::Downstream, FrameBody::HelloAck(ack)) if !state.verified => {
                if state.fence.as_ref() != Some(&ack.actual_fence)
                    || ![
                        TERMINAL_INPUT_INTENT_CAPABILITY,
                        TERMINAL_STATE_BINARY_CAPABILITY,
                        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    ]
                    .iter()
                    .all(|required| {
                        ack.selected_capabilities
                            .iter()
                            .any(|capability| capability == required)
                    })
                    || !ack
                        .selected_capabilities
                        .iter()
                        .all(|capability| state.requested.contains(capability))
                {
                    self.disable(&mut state);
                    return;
                }
                state.verified = true;
                state.requested.clear();
            }
            (_, FrameBody::Hello(_) | FrameBody::HelloAck(_) | FrameBody::Detach(_)) => {
                self.disable(&mut state)
            }
            _ => {}
        }
    }
}

impl Drop for ConnectionObserver {
    fn drop(&mut self) {
        self.registry.update(self.id, None);
    }
}

/// Preserve exact framed bytes, including future/oversized frames. Observation
/// is bounded independently from forwarding; oversized payloads stream through
/// without allocation and permanently retire only this observation.
pub fn copy_observed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    observer: Option<&ConnectionObserver>,
    direction: Direction,
) -> io::Result<u64> {
    let result = (|| {
        let mut total = 0;
        loop {
            let mut prefix = [0_u8; 4];
            if reader.read(&mut prefix[..1])? == 0 {
                return Ok(total);
            }
            reader.read_exact(&mut prefix[1..])?;
            let length = u32::from_be_bytes(prefix) as usize;
            if length > MAX_OBSERVED_FRAME_BYTES {
                if let Some(observer) = observer {
                    observer.close();
                }
                writer.write_all(&prefix)?;
                let copied = io::copy(&mut reader.take(length as u64), writer)?;
                if copied != length as u64 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
            } else {
                let mut frame = Vec::with_capacity(4 + length);
                frame.extend_from_slice(&prefix);
                frame.resize(4 + length, 0);
                reader.read_exact(&mut frame[4..])?;
                if let Some(observer) = observer {
                    observer.observe(direction, &frame);
                }
                writer.write_all(&frame)?;
            }
            writer.flush()?;
            total += 4 + length as u64;
        }
    })();
    if let Some(observer) = observer {
        observer.close();
    }
    result
}

#[cfg(test)]
#[path = "terminal_width_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "terminal_width_native_tests.rs"]
mod native_tests;
