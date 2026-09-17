#![cfg(feature = "terminal-state-stream")]

use hmux_host::local_protocol::SessionFence;
use hmux_host::terminal_replay::{TerminalReplay, TerminalReplayError, TerminalReplayLimits};
use std::time::{Duration, Instant};
use terminal_state_protocol::{ViewportFrame, terminal_state_record};

const HISTORY_ROWS: usize = 1_000_000;
const HOT_RESERVE_ROWS: u64 = 4_096;
const VIEWPORT_ROWS: u16 = 24;
const SOURCE_COLUMNS: u16 = 80;
const RESIZED_COLUMNS: u16 = SOURCE_COLUMNS - 1;
const INTERACTIVE_BUDGET: Duration = Duration::from_millis(16);

fn replay() -> TerminalReplay {
    TerminalReplay::new(
        SessionFence {
            workspace_id: "million-row-workspace".into(),
            session_id: "million-row-session".into(),
            runner_principal: "million-row-runner".into(),
            runner_instance: "million-row-runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "million-row-host-1".into(),
            terminal_epoch: "million-row-terminal-1".into(),
        },
        VIEWPORT_ROWS,
        SOURCE_COLUMNS,
        TerminalReplayLimits {
            max_history_logical_lines: HISTORY_ROWS,
            ..TerminalReplayLimits::default()
        },
    )
    .unwrap()
}

fn ingest_with_capacity_wait(replay: &mut TerminalReplay, bytes: &[u8], deadline: Instant) {
    loop {
        match replay.ingest_output(bytes) {
            Ok(ingested) => {
                assert_eq!(
                    ingested.history_degradation, None,
                    "the product cold-history tier degraded during ordinary ingest"
                );
                loop {
                    match replay.checkpoint() {
                        Ok(_) => return,
                        Err(
                            TerminalReplayError::HistoryStorageBackpressure { .. }
                            | TerminalReplayError::ColdHistoryRecoveryRequired,
                        ) => {
                            assert!(
                                Instant::now() < deadline,
                                "cold publication did not reconcile after PTY ingest"
                            );
                            std::thread::yield_now();
                        }
                        Err(error) => panic!("million-row history reconciliation failed: {error}"),
                    }
                }
            }
            Err(
                TerminalReplayError::HistoryStorageBackpressure { .. }
                | TerminalReplayError::ColdHistoryRecoveryRequired,
            ) => {
                assert!(
                    Instant::now() < deadline,
                    "cold publication did not release real PTY capacity"
                );
                std::thread::yield_now();
            }
            Err(error) => panic!("million-row PTY ingest failed: {error}"),
        }
    }
}

fn viewport_frame(record: &terminal_state_protocol::TerminalStateRecord) -> &ViewportFrame {
    match record.body.as_ref().unwrap() {
        terminal_state_record::Body::ViewportFrame(frame) => frame,
        _ => panic!("expected a complete viewport frame"),
    }
}

#[test]
fn million_row_cold_history_resize_and_first_frame_fit_one_interactive_budget() {
    const ROWS_PER_BATCH: usize = 4_096;

    let setup_started = Instant::now();
    let deadline = setup_started + Duration::from_secs(180);
    let mut replay = replay();
    let full_batch = b"x\r\n".repeat(ROWS_PER_BATCH);
    let full_batches = (HISTORY_ROWS - 1) / ROWS_PER_BATCH;
    for _ in 0..full_batches {
        ingest_with_capacity_wait(&mut replay, &full_batch, deadline);
    }
    let remainder = HISTORY_ROWS - 1 - full_batches * ROWS_PER_BATCH;
    if remainder > 0 {
        ingest_with_capacity_wait(&mut replay, &b"x\r\n".repeat(remainder), deadline);
    }
    ingest_with_capacity_wait(&mut replay, b"MILLION_ROW_TAIL", deadline);

    let checkpoint = loop {
        match replay.checkpoint() {
            Ok(checkpoint) => break checkpoint,
            Err(
                TerminalReplayError::HistoryStorageBackpressure { .. }
                | TerminalReplayError::ColdHistoryRecoveryRequired,
            ) => {
                assert!(
                    Instant::now() < deadline,
                    "million-row cold history did not reach a complete root"
                );
                std::thread::yield_now();
            }
            Err(error) => panic!("million-row checkpoint failed: {error}"),
        }
    };
    let cold = checkpoint
        .cold_history
        .expect("one million rows must cross the product cold-history tier");
    assert!(
        cold.end_logical_line_id
            >= u64::try_from(HISTORY_ROWS)
                .unwrap()
                .saturating_sub(HOT_RESERVE_ROWS + u64::from(VIEWPORT_ROWS)),
        "older rows were not retained in the native cold root: {cold:?}"
    );

    let mut projection = replay.attach_view_projection().unwrap();
    let before_revision = replay.current_terminal_state_revision();
    let output_seq = replay.current_output_seq();
    let started = Instant::now();
    replay.resize(VIEWPORT_ROWS, RESIZED_COLUMNS).unwrap();
    let resized_at = Instant::now();
    let request = projection.capture_request().unwrap();
    let source = replay
        .capture_viewport_source(&[request], usize::MAX)
        .unwrap();
    let source_captured_at = Instant::now();
    let captured = source
        .capture_latest_viewport_frame(&mut projection)
        .unwrap()
        .expect("the resized generation must publish one complete first frame");
    let rows_projected_at = Instant::now();
    let record = captured.finish().unwrap();
    let elapsed = started.elapsed();

    let frame = viewport_frame(&record);
    eprintln!(
        "million_row_setup={:?} cold_end={} resize={:?} source_capture={:?} \
         row_projection={:?} finish={:?} resize_and_first_frame={elapsed:?}",
        setup_started.elapsed(),
        cold.end_logical_line_id,
        resized_at.duration_since(started),
        source_captured_at.duration_since(resized_at),
        rows_projected_at.duration_since(source_captured_at),
        Instant::now().duration_since(rows_projected_at),
    );
    assert_eq!(record.through_output_seq, output_seq);
    assert_eq!(record.state_revision, before_revision + 1);
    assert_eq!(frame.canonical_columns, u32::from(RESIZED_COLUMNS));
    assert_eq!(frame.viewport_rows, u32::from(VIEWPORT_ROWS));
    assert_eq!(frame.rows.len(), usize::from(VIEWPORT_ROWS));
    assert!(frame.follow_tail);
    assert!(
        frame.has_more_before,
        "the retained million-row prefix vanished"
    );
    assert!(
        elapsed < INTERACTIVE_BUDGET,
        "canonical resize plus its first complete product frame took {elapsed:?}, \
         exceeding the {INTERACTIVE_BUDGET:?} interactive budget"
    );
}
