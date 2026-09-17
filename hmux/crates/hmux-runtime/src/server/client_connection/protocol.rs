//! Framing, attach replay selection, and outbound delivery for one client.

use crate::Result;
use crate::subscriber_delivery::{FrameQueue, OutboundRecord, SnapshotProjection};
use hmux_host::local_protocol::{
    ErrorCode, ErrorFrame, FrameBody, FrameCodec, FrameLimits, OutputDelta, PROTOCOL_V1,
    ReconnectCursor, ReplayGap, RetryPosture, ScreenSnapshot, ScreenSnapshotProfile, SessionFence,
    WireFrame,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::local_transport::FrameWriter;
use hmux_host::local_transport::TransportInterrupt;
use hmux_host::session_host::SessionHost;
use hmux_host::terminal_replay::ReplayResult;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::transport::SharedFrameWriter;

/// Where the live outbound producer starts numbering when the attach reply left
/// room. Kept at the historical base so a plain attach numbers exactly as it
/// did before reconnect resume added a variable-length reply.
pub(crate) const FIRST_OUTBOUND_FRAME_ID: u64 = 100;

/// What the Host puts on the wire between the `HelloAck` and the live stream.
///
/// Exactly one variant is chosen per attach, and the three are distinguishable
/// by frame kind alone — see `RECONNECT_RESUME_CAPABILITY` for the contract the
/// client reads this by.
pub(crate) enum AttachReply {
    /// The legacy answer: one canonical snapshot. Also the answer to a cursor
    /// the Host declined for a reason that is *not* a hole in the stream, which
    /// is why it carries no `ReplayGap` — there is nothing the client lost.
    Snapshot(ScreenSnapshot),
    /// The cursor had fallen out of the retained window. The gap frame is the
    /// honest statement that bytes are missing; the snapshot is the recovery.
    SnapshotAfterGap(ReplayGap, ScreenSnapshot),
    /// The Host served the cursor: retained deltas after it, and no snapshot.
    Resume(Vec<OutputDelta>),
}

/// Decides the attach reply for one connection, under the Host lock.
///
/// Under the lock on purpose: `HelloAck.current_output_seq`, the replay, and the
/// subscriber registration must all observe the same Host state, or the resume
/// would either duplicate a delta the live queue also delivers or skip one that
/// landed in between.
pub(crate) fn attach_reply(
    host: &SessionHost,
    fence: &SessionFence,
    cursor: Option<&ReconnectCursor>,
    profile: ScreenSnapshotProfile,
    projection: SnapshotProjection,
) -> Result<AttachReply> {
    attach_reply_with_snapshot(host, fence, cursor, || {
        let snapshot = host.current_snapshot(profile)?;
        Ok(projection.apply(snapshot))
    })
}

fn attach_reply_with_snapshot(
    host: &SessionHost,
    fence: &SessionFence,
    cursor: Option<&ReconnectCursor>,
    mut current_snapshot: impl FnMut() -> Result<ScreenSnapshot>,
) -> Result<AttachReply> {
    let Some(cursor) = cursor else {
        return Ok(AttachReply::Snapshot(current_snapshot()?));
    };
    // An already-current cursor resumes with zero frames, checked before any
    // decline. This is the invariant that lets the client tell "nothing to
    // send" from "a snapshot is coming" without a marker frame, and it has to
    // hold even for an exited session, whose `replay_after` refuses outright.
    if cursor.terminal_epoch == fence.terminal_epoch
        && cursor.after_output_seq == host.current_output_seq()
    {
        return Ok(AttachReply::Resume(Vec::new()));
    }
    match host.replay_after(fence, cursor) {
        Ok(ReplayResult::Deltas(deltas)) => {
            // Resume must never cost more than the snapshot it replaces.
            // Retention holds up to `max_retained_bytes` (4 MiB), so a client
            // that was away through a noisy build can be further behind than a
            // full snapshot is large — and then replaying is the *worse* answer
            // on exactly the link resume exists for. Over that budget the
            // canonical snapshot is both smaller and complete, so this is a
            // plain `Snapshot`: nothing observable was lost, and claiming a
            // `ReplayGap` here would report a hole that does not exist.
            let replay_bytes: usize = deltas.iter().map(|delta| delta.bytes.len()).sum();
            if replay_bytes > FrameLimits::default().max_snapshot_bytes {
                return Ok(AttachReply::Snapshot(current_snapshot()?));
            }
            Ok(AttachReply::Resume(deltas))
        }
        Ok(ReplayResult::Gap(gap)) => Ok(AttachReply::SnapshotAfterGap(gap, current_snapshot()?)),
        // Exited, fenced to another terminal epoch, or a cursor claiming output
        // this Host never produced. None of those is a retention hole, and all
        // of them are answered by the canonical screen.
        Err(_) => Ok(AttachReply::Snapshot(current_snapshot()?)),
    }
}

pub(crate) fn send_body(
    codec: &FrameCodec,
    writer: &SharedFrameWriter,
    frame_id: u64,
    body: FrameBody,
) -> Result<()> {
    let encoded = codec.encode(&WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id,
        body,
    })?;
    let mut writer = writer
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned")?;
    writer.write_frame(&encoded)?;
    Ok(())
}

#[cfg(feature = "terminal-state-stream")]
fn send_terminal_state(writer: &SharedFrameWriter, encoded: &[u8]) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned")?;
    write_terminal_state(&mut **writer, encoded)
}

#[cfg(feature = "terminal-state-stream")]
fn write_terminal_state(writer: &mut dyn FrameWriter, encoded: &[u8]) -> Result<()> {
    if encoded.len() > terminal_state_protocol::MAX_ENVELOPE_BYTES {
        return Err("structured terminal record exceeds its bounded envelope".into());
    }
    let length = u32::try_from(encoded.len())
        .map_err(|_| "structured terminal record length exceeds u32")?;
    let mut framed = Vec::with_capacity(4 + encoded.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(encoded);
    writer.write_frame(&framed)?;
    Ok(())
}

#[cfg(feature = "terminal-state-stream")]
fn send_terminal_state_batch(writer: &SharedFrameWriter, records: &[Arc<[u8]>]) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned")?;
    for record in records {
        write_terminal_state(&mut **writer, record)?;
    }
    Ok(())
}

pub(crate) fn run_subscriber_outbound(
    writer: &SharedFrameWriter,
    interrupt: &Arc<dyn TransportInterrupt>,
    receiver: Arc<FrameQueue>,
    backpressure: Arc<AtomicBool>,
    first_frame_id: u64,
) {
    let codec = FrameCodec::new(FrameLimits::default());
    let mut frame_id = first_frame_id;
    while !backpressure.load(Ordering::Acquire) {
        let Some(record) = receiver.pop() else {
            break;
        };
        if backpressure.load(Ordering::Acquire) {
            break;
        }
        let (sent, frame_count) = match record {
            OutboundRecord::Json(body) => (
                send_body(&codec, writer, frame_id, body.as_ref().clone()),
                1,
            ),
            #[cfg(feature = "terminal-state-stream")]
            OutboundRecord::TerminalState(bytes) => (send_terminal_state(writer, &bytes), 1),
            #[cfg(feature = "terminal-state-stream")]
            OutboundRecord::TerminalViewportBatch(records) => (
                send_terminal_state_batch(writer, &records),
                u64::try_from(records.len()).unwrap_or(u64::MAX),
            ),
        };
        if sent.is_err() {
            receiver.close();
            interrupt.interrupt();
            return;
        }
        frame_id = frame_id.saturating_add(frame_count);
    }
    if backpressure.load(Ordering::Acquire) {
        let _ = send_body(
            &codec,
            writer,
            frame_id,
            FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::ResourceLimit,
                message: "Hmux subscriber output backlog requires snapshot recovery".to_string(),
                retry: RetryPosture::Reconnect,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        );
    }
    if let Ok(mut writer) = writer.lock() {
        let _ = writer.close_write();
    }
    interrupt.interrupt();
}

pub(crate) fn write_error(
    codec: &FrameCodec,
    writer: &SharedFrameWriter,
    code: ErrorCode,
    message: &str,
    retry: RetryPosture,
) -> Result<()> {
    send_body(codec, writer, 1, error_body(code, message, retry))
}

pub(crate) fn write_error_before(
    codec: &FrameCodec,
    writer: &SharedFrameWriter,
    code: ErrorCode,
    message: &str,
    retry: RetryPosture,
    deadline: Option<Instant>,
) -> Result<()> {
    let encoded = codec.encode(&WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: error_body(code, message, retry),
    })?;
    let mut writer = writer
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned")?;
    writer.write_frame_before(&encoded, deadline)?;
    Ok(())
}

fn error_body(code: ErrorCode, message: &str, retry: RetryPosture) -> FrameBody {
    FrameBody::Error(ErrorFrame {
        origin_code: None,
        code,
        message: message.to_string(),
        retry,
        required_capability: None,
        supported_versions: None,
        in_reply_to_request_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriber_delivery::{QUEUE_MAX_ACCOUNTED_BYTES, QUEUE_RECORD_OVERHEAD_BYTES};
    use crate::subscriber_queue::{BoundedQueue, PushError};
    use hmux_host::local_protocol::{
        AgentRuntimeStateSource, Detach, ProcessProof, ProviderConversationIdentitySource,
    };
    use hmux_host::local_transport::memory::MemoryEndpoint;
    use hmux_host::local_transport::{FrameWriter, TransportError};
    use hmux_host::terminal_replay::{
        AgentRuntimeObservation, ProviderConversationIdentityObservation, TerminalReplayLimits,
    };
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    struct NoopInterrupt;

    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    struct RejectingWriter;

    impl FrameWriter for RejectingWriter {
        fn write_frame(&mut self, _encoded: &[u8]) -> std::result::Result<(), TransportError> {
            Err(TransportError::Io {
                operation: "reject test frame",
                source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "test writer closed"),
            })
        }

        fn close_write(&mut self) -> std::result::Result<(), TransportError> {
            Ok(())
        }
    }

    fn resume_fence() -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        }
    }

    fn resume_host(replay_limits: TerminalReplayLimits) -> SessionHost {
        SessionHost::new(
            resume_fence(),
            ProcessProof {
                process_id: 11,
                start_marker: "provider-start".into(),
            },
            24,
            80,
            replay_limits,
            2,
        )
        .unwrap()
    }

    fn cursor(after_output_seq: u64) -> ReconnectCursor {
        ReconnectCursor {
            terminal_epoch: resume_fence().terminal_epoch,
            after_output_seq,
        }
    }

    fn counted_attach_reply(
        host: &SessionHost,
        cursor: Option<&ReconnectCursor>,
    ) -> (AttachReply, usize, usize) {
        let snapshot_calls = std::cell::Cell::new(0_usize);
        let formatted_bytes = std::cell::Cell::new(0_usize);
        let reply = attach_reply_with_snapshot(host, &resume_fence(), cursor, || {
            snapshot_calls.set(snapshot_calls.get().saturating_add(1));
            let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full)?;
            formatted_bytes.set(
                formatted_bytes
                    .get()
                    .saturating_add(snapshot.repaint_bytes.len()),
            );
            Ok(snapshot)
        })
        .unwrap();
        (reply, snapshot_calls.get(), formatted_bytes.get())
    }

    #[test]
    fn a_served_cursor_replays_only_what_follows_it_and_sends_no_snapshot() {
        let mut host = resume_host(TerminalReplayLimits::default());
        let fence = resume_fence();
        for line in [&b"one"[..], b"two", b"three", b"four"] {
            host.ingest_output(&fence, line).unwrap();
        }

        let requested_cursor = cursor(2);
        let (reply, snapshot_calls, formatted_bytes) =
            counted_attach_reply(&host, Some(&requested_cursor));
        assert_eq!(snapshot_calls, 0);
        assert_eq!(formatted_bytes, 0);

        let AttachReply::Resume(deltas) = reply else {
            panic!("a cursor inside the retained window must be served, not redownloaded");
        };
        assert_eq!(
            deltas
                .iter()
                .map(|delta| delta.output_seq)
                .collect::<Vec<_>>(),
            vec![3, 4],
            "resume must start after the cursor, not at the window's start"
        );
        assert_eq!(
            deltas
                .iter()
                .map(|delta| delta.bytes.clone())
                .collect::<Vec<_>>(),
            vec![b"three".to_vec(), b"four".to_vec()]
        );
    }

    #[test]
    fn a_current_cursor_resumes_with_no_frames_at_all() {
        let mut host = resume_host(TerminalReplayLimits::default());
        let fence = resume_fence();
        host.ingest_output(&fence, b"one").unwrap();

        let requested_cursor = cursor(host.current_output_seq());
        let (reply, snapshot_calls, formatted_bytes) =
            counted_attach_reply(&host, Some(&requested_cursor));

        assert!(matches!(reply, AttachReply::Resume(deltas) if deltas.is_empty()));
        assert_eq!(snapshot_calls, 0);
        assert_eq!(formatted_bytes, 0);
    }

    #[test]
    fn a_cursor_that_fell_out_of_the_window_gets_a_gap_before_the_snapshot() {
        let mut host = resume_host(TerminalReplayLimits {
            max_retained_records: 2,
            ..TerminalReplayLimits::default()
        });
        let fence = resume_fence();
        for line in [&b"one"[..], b"two", b"three", b"four"] {
            host.ingest_output(&fence, line).unwrap();
        }
        assert_eq!(host.earliest_retained_output_seq(), 3);

        let requested_cursor = cursor(1);
        let (reply, snapshot_calls, formatted_bytes) =
            counted_attach_reply(&host, Some(&requested_cursor));

        let AttachReply::SnapshotAfterGap(gap, snapshot) = reply else {
            panic!("a cursor behind the retained window must be reported as a gap");
        };
        assert_eq!(gap.cursor.after_output_seq, 1);
        assert_eq!(gap.earliest_retained_output_seq, 3);
        assert_eq!(gap.current_output_seq, 4);
        assert_eq!(snapshot.sequence_through, 4);
        assert_eq!(snapshot_calls, 1);
        assert!(formatted_bytes > 0);
    }

    #[test]
    fn a_replay_larger_than_a_snapshot_falls_back_without_claiming_a_gap() {
        let limits = TerminalReplayLimits::default();
        let budget = FrameLimits::default().max_snapshot_bytes;
        let mut host = resume_host(limits);
        let fence = resume_fence();
        let chunk = vec![b'x'; 32 * 1024];
        let mut written = 0;
        while written <= budget {
            host.ingest_output(&fence, &chunk).unwrap();
            written += chunk.len();
        }
        assert_eq!(host.earliest_retained_output_seq(), 1);

        let requested_cursor = cursor(0);
        let (reply, snapshot_calls, formatted_bytes) =
            counted_attach_reply(&host, Some(&requested_cursor));

        assert!(
            matches!(reply, AttachReply::Snapshot(_)),
            "a replay over the snapshot budget must fall back to the snapshot"
        );
        assert_eq!(snapshot_calls, 1);
        assert!(formatted_bytes > 0);
    }

    #[test]
    fn no_cursor_still_produces_the_plain_snapshot_reply() {
        let mut host = resume_host(TerminalReplayLimits::default());
        let fence = resume_fence();
        host.ingest_output(&fence, b"one").unwrap();

        let (reply, snapshot_calls, formatted_bytes) = counted_attach_reply(&host, None);

        assert!(matches!(reply, AttachReply::Snapshot(_)));
        assert_eq!(snapshot_calls, 1);
        assert!(formatted_bytes > 0);
    }

    #[test]
    fn attach_reply_projects_exact_negotiated_semantic_snapshot_matrix() {
        let mut host = resume_host(TerminalReplayLimits::default());
        let fence = resume_fence();
        host.observe_agent_runtime_state(
            &fence,
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ProviderEvent),
        )
        .unwrap();
        host.observe_provider_conversation_identity(
            &fence,
            ProviderConversationIdentityObservation::new(
                "test-provider",
                "conversation-1",
                ProviderConversationIdentitySource::ProviderEvent,
            ),
        )
        .unwrap();

        for (agent_runtime_state, provider_conversation_identity) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let reply = attach_reply(
                &host,
                &fence,
                None,
                ScreenSnapshotProfile::Full,
                SnapshotProjection::new(agent_runtime_state, provider_conversation_identity),
            )
            .unwrap();
            let AttachReply::Snapshot(actual) = reply else {
                panic!("cold attach must return a snapshot");
            };
            assert_eq!(
                actual.agent_runtime_state.is_some(),
                agent_runtime_state,
                "agent runtime projection must match negotiation"
            );
            assert_eq!(
                actual.provider_conversation_identity.is_some(),
                provider_conversation_identity,
                "provider identity projection must match negotiation"
            );
        }
    }

    struct AttachBatchMetrics {
        elapsed: Duration,
        formatted_bytes: usize,
        p95: Duration,
        snapshot_calls: usize,
    }

    fn concurrent_attach_batch(
        host: &Mutex<SessionHost>,
        cursor: Option<ReconnectCursor>,
        count: usize,
    ) -> AttachBatchMetrics {
        let barrier = std::sync::Barrier::new(count);
        let snapshot_calls = AtomicUsize::new(0);
        let formatted_bytes = AtomicUsize::new(0);
        let batch_started = Instant::now();
        let mut latencies = std::thread::scope(|scope| {
            let mut tasks = Vec::with_capacity(count);
            for _ in 0..count {
                let cursor = cursor.clone();
                let barrier = &barrier;
                let snapshot_calls = &snapshot_calls;
                let formatted_bytes = &formatted_bytes;
                tasks.push(scope.spawn(move || {
                    barrier.wait();
                    let started = Instant::now();
                    let host = host.lock().unwrap();
                    let reply =
                        attach_reply_with_snapshot(&host, &resume_fence(), cursor.as_ref(), || {
                            snapshot_calls.fetch_add(1, Ordering::Relaxed);
                            let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full)?;
                            formatted_bytes
                                .fetch_add(snapshot.repaint_bytes.len(), Ordering::Relaxed);
                            Ok(snapshot)
                        })
                        .unwrap();
                    if cursor.is_some() {
                        assert!(matches!(reply, AttachReply::Resume(_)));
                    } else {
                        assert!(matches!(reply, AttachReply::Snapshot(_)));
                    }
                    started.elapsed()
                }));
            }
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        latencies.sort_unstable();
        let p95_index = count.saturating_mul(95).div_ceil(100).saturating_sub(1);
        let p95 = latencies[p95_index];
        AttachBatchMetrics {
            elapsed: batch_started.elapsed(),
            formatted_bytes: formatted_bytes.load(Ordering::Relaxed),
            p95,
            snapshot_calls: snapshot_calls.load(Ordering::Relaxed),
        }
    }

    #[test]
    fn ten_and_hundred_concurrent_attaches_keep_snapshot_work_bounded() {
        let mut host = resume_host(TerminalReplayLimits::default());
        let fence = resume_fence();
        for line in 0..256 {
            host.ingest_output(
                &fence,
                format!("line-{line:04} {}\n", "x".repeat(120)).as_bytes(),
            )
            .unwrap();
        }
        let current = cursor(host.current_output_seq());
        let host = Mutex::new(host);

        for count in [10, 100] {
            let cold = concurrent_attach_batch(&host, None, count);
            let resume = concurrent_attach_batch(&host, Some(current.clone()), count);
            eprintln!(
                "Hmux concurrent attach {count}x: cold elapsed={:?} p95={:?} snapshots={} formatted_bytes={}; resume elapsed={:?} p95={:?} snapshots={} formatted_bytes={}",
                cold.elapsed,
                cold.p95,
                cold.snapshot_calls,
                cold.formatted_bytes,
                resume.elapsed,
                resume.p95,
                resume.snapshot_calls,
                resume.formatted_bytes,
            );
            assert_eq!(cold.snapshot_calls, count);
            assert!(cold.formatted_bytes > 0);
            assert!(
                cold.formatted_bytes
                    <= count.saturating_mul(FrameLimits::default().max_snapshot_bytes)
            );
            assert_eq!(resume.snapshot_calls, 0);
            assert_eq!(resume.formatted_bytes, 0);
            assert!(cold.p95 < Duration::from_secs(2));
            assert!(resume.p95 < Duration::from_secs(2));
            assert!(cold.elapsed < Duration::from_secs(5));
            assert!(resume.elapsed < Duration::from_secs(5));
        }
    }

    fn subscriber_queue(max_records: usize, max_accounted_bytes: usize) -> Arc<FrameQueue> {
        Arc::new(BoundedQueue::new(
            max_records,
            max_accounted_bytes,
            Duration::from_secs(5),
        ))
    }

    #[test]
    fn sealed_outbound_delivers_final_output_and_exit_before_interrupting_the_reader() {
        struct DrainObserver {
            peer: Mutex<MemoryEndpoint>,
            expected: Vec<FrameBody>,
            interrupted: AtomicBool,
        }

        impl TransportInterrupt for DrainObserver {
            fn interrupt(&self) {
                let codec = FrameCodec::new(FrameLimits::default());
                let mut peer = self.peer.lock().unwrap();
                for (index, expected) in self.expected.iter().enumerate() {
                    let frame = codec.read_from(&mut *peer).unwrap();
                    assert_eq!(frame.frame_id, FIRST_OUTBOUND_FRAME_ID + index as u64);
                    assert_eq!(&frame.body, expected);
                }
                assert_eq!(std::io::Read::read(&mut *peer, &mut [0]).unwrap(), 0);
                self.interrupted.store(true, Ordering::Release);
            }
        }

        let expected = vec![
            FrameBody::OutputDelta(OutputDelta {
                terminal_epoch: "terminal-1".into(),
                output_seq: 1,
                bytes: b"final output\r\n".to_vec(),
                rows: None,
                columns: None,
                working_directory: None,
                execution_location: None,
                agent_identity: None,
            }),
            FrameBody::Exit(hmux_host::local_protocol::Exit {
                final_output_seq: 1,
                exit_code: Some(0),
                platform_status: None,
                reason: "completed".into(),
            }),
        ];
        let receiver = subscriber_queue(expected.len(), QUEUE_MAX_ACCOUNTED_BYTES);
        for body in &expected {
            receiver
                .try_push(
                    OutboundRecord::Json(Arc::new(body.clone())),
                    QUEUE_RECORD_OVERHEAD_BYTES,
                )
                .unwrap();
        }
        receiver.close();
        let (transport, peer) = MemoryEndpoint::pair();
        let writer = super::super::transport::shared_frame_writer(transport);
        let observer = Arc::new(DrainObserver {
            peer: Mutex::new(peer),
            expected,
            interrupted: AtomicBool::new(false),
        });
        let interrupt: Arc<dyn TransportInterrupt> = observer.clone();
        run_subscriber_outbound(
            &writer,
            &interrupt,
            receiver,
            Arc::new(AtomicBool::new(false)),
            FIRST_OUTBOUND_FRAME_ID,
        );
        assert!(observer.interrupted.load(Ordering::Acquire));
    }

    #[test]
    fn outbound_reports_resource_limit_before_backpressure_disconnect() {
        let (transport, mut peer) = MemoryEndpoint::pair();
        let writer = super::super::transport::shared_frame_writer(transport);
        let interrupt: Arc<dyn TransportInterrupt> = Arc::new(NoopInterrupt);
        let receiver = subscriber_queue(1, QUEUE_MAX_ACCOUNTED_BYTES);
        let backpressure = Arc::new(AtomicBool::new(true));
        receiver
            .try_push(
                OutboundRecord::Json(Arc::new(FrameBody::Detach(Detach { reason: None }))),
                QUEUE_RECORD_OVERHEAD_BYTES,
            )
            .unwrap();

        run_subscriber_outbound(
            &writer,
            &interrupt,
            receiver,
            backpressure,
            FIRST_OUTBOUND_FRAME_ID,
        );

        let frame = FrameCodec::new(FrameLimits::default())
            .read_from(&mut peer)
            .unwrap();
        let FrameBody::Error(error) = frame.body else {
            panic!("expected typed backpressure error");
        };
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert_eq!(error.retry, RetryPosture::Reconnect);
    }

    #[test]
    fn outbound_write_failure_closes_the_producer_queue() {
        let writer = super::super::transport::shared_frame_writer(RejectingWriter);
        let interrupt: Arc<dyn TransportInterrupt> = Arc::new(NoopInterrupt);
        let receiver = subscriber_queue(2, QUEUE_MAX_ACCOUNTED_BYTES);
        receiver
            .try_push(
                OutboundRecord::Json(Arc::new(FrameBody::Detach(Detach { reason: None }))),
                QUEUE_RECORD_OVERHEAD_BYTES,
            )
            .unwrap();

        run_subscriber_outbound(
            &writer,
            &interrupt,
            Arc::clone(&receiver),
            Arc::new(AtomicBool::new(false)),
            FIRST_OUTBOUND_FRAME_ID,
        );

        assert_eq!(
            receiver.try_push(
                OutboundRecord::Json(Arc::new(FrameBody::Detach(Detach { reason: None }))),
                QUEUE_RECORD_OVERHEAD_BYTES,
            ),
            Err(PushError::Closed)
        );
    }
}
