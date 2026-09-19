mod causal_reports;
mod controller_input;

use super::*;
use crate::local_protocol::{ScreenSnapshotProfile, WorkingDirectorySource};

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        runner_principal: "runner".into(),
        runner_instance: "runner-1".into(),
        channel_epoch: 1,
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
    }
}

fn replay_with_limits(limits: TerminalReplayLimits) -> TerminalReplay {
    TerminalReplay::new(fence(), 4, 20, limits).unwrap()
}

#[test]
fn output_sequence_is_strictly_monotonic() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());

    assert_eq!(replay.ingest_output(b"one").unwrap().output_seq, 1);
    assert_eq!(replay.ingest_output(b"two").unwrap().output_seq, 2);
    assert_eq!(replay.current_output_seq(), 2);
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn command_bridge_marker_reaches_the_structured_stream_across_pty_reads() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let first = replay
        .ingest_output(b"\x1b]778;dure-hmux-command-")
        .unwrap();
    assert!(first.terminal_records.is_empty());
    let completed = replay
        .ingest_output(b"bridge-v1;eyJvayI6dHJ1ZX0\x07")
        .unwrap();
    assert_eq!(completed.terminal_records.len(), 1);
    let record = &completed.terminal_records[0];
    assert_eq!(record.terminal_epoch, replay.fence().terminal_epoch);
    assert_eq!(record.through_output_seq, 2);
    let Some(terminal_state_protocol::terminal_state_record::Body::Event(event)) = &record.body
    else {
        panic!("command bridge must publish a typed event");
    };
    assert_eq!(event.event_id, 1);
    let Some(terminal_state_protocol::terminal_event::Event::ExecutionMarker(marker)) =
        &event.event
    else {
        panic!("command bridge must publish an execution marker");
    };
    assert_eq!(marker.label, "dure-hmux-command-bridge-v1;eyJvayI6dHJ1ZX0");
    terminal_state_protocol::encode_record(1, record).unwrap();
    assert!(
        replay
            .ingest_output(b"plain output")
            .unwrap()
            .terminal_records
            .is_empty()
    );
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn native_history_clear_advances_state_and_keeps_the_live_viewport() {
    let visible_viewport = |record: terminal_state_protocol::TerminalStateRecord| {
        let Some(terminal_state_protocol::terminal_state_record::Body::ViewportFrame(frame)) =
            record.body
        else {
            panic!("current viewport projection did not produce a viewport frame")
        };
        let tables = frame.tables.as_ref().unwrap();
        frame
            .rows
            .iter()
            .map(|row| {
                row.cells
                    .iter()
                    .map(|cell| tables.graphemes[cell.grapheme_index as usize].text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
    };
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    for index in 0..12 {
        replay
            .ingest_output(format!("history-{index:02}\r\n").as_bytes())
            .unwrap();
    }
    replay
        .ingest_output(b"\x1b[2J\x1b[HVISIBLE-0\r\nVISIBLE-1\r\nVISIBLE-2\r\nVISIBLE-3")
        .unwrap();
    let mut projection = replay.attach_view_projection().unwrap();
    let visible_before = visible_viewport(
        replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("initial current viewport frame")
            .finish()
            .unwrap(),
    );
    assert!(visible_before.iter().any(|row| row.contains("VISIBLE-0")));
    let revision_before = replay.current_terminal_state_revision();

    let cleared = replay.ingest_output(b"\x1b[3J").unwrap();

    assert!(cleared.projection_changed);
    let visible_after = visible_viewport(
        replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("history clear must publish a current viewport frame")
            .finish()
            .unwrap(),
    );
    assert_eq!(visible_after, visible_before);
    assert!(visible_after.iter().all(|row| !row.contains("history-")));
    assert!(
        replay.current_terminal_state_revision() > revision_before,
        "clearing Ghostty history must advance canonical state even when visible cells do not change"
    );
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn ghostty_terminal_replies_leave_the_actor_as_one_redacted_effect() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let ingested = replay
        .ingest_output(b"\x1b[2J\x1b[H\x1b[c\x1b[5n\x1b[6n")
        .unwrap();

    assert_eq!(ingested.output_seq, 1);
    assert_eq!(ingested.pty_replies, b"\x1b[?62;22c\x1b[0n\x1b[1;1R");
    assert!(!ingested.pty_reply_overflow);
    let debug = format!("{ingested:?}");
    assert!(debug.contains("pty_replies_len: 19"));
    assert!(!debug.contains("?62;22c"));
}

#[test]
fn first_output_after_resize_carries_the_canonical_grid_once() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"before").unwrap();

    replay.resize(19, 67).unwrap();
    let redraw = replay.ingest_output(b"redraw").unwrap();
    let continued = replay.ingest_output(b"continued").unwrap();

    assert_eq!((redraw.rows, redraw.columns), (Some(19), Some(67)));
    assert_eq!((continued.rows, continued.columns), (None, None));

    // A repeated measurement is not a new runtime fact and must not break an
    // otherwise coalescible output stream.
    replay.resize(19, 67).unwrap();
    let unchanged = replay.ingest_output(b"unchanged").unwrap();
    assert_eq!((unchanged.rows, unchanged.columns), (None, None));
}

#[test]
fn snapshot_through_n_is_followed_by_delta_n_plus_one() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"first").unwrap();
    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let next = replay.ingest_output(b" second").unwrap();

    assert_eq!(snapshot.sequence_through, 1);
    assert_eq!(next.output_seq, snapshot.sequence_through + 1);
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 0);
    restored.process(&snapshot.repaint_bytes);
    assert!(restored.screen().contents().contains("first"));
    assert!(!restored.screen().contents().contains("second"));
}

#[test]
fn recovered_presentation_seeds_successor_without_consuming_output_sequence() {
    let mut predecessor = replay_with_limits(TerminalReplayLimits::default());
    predecessor.ingest_output(b"before-reboot\r\n").unwrap();
    let predecessor_snapshot = predecessor.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut successor_fence = fence();
    successor_fence.session_id = "successor-session".into();
    successor_fence.runner_instance = "runner-2".into();
    successor_fence.host_instance_id = "host-2".into();
    successor_fence.terminal_epoch = "terminal-2".into();
    let mut successor =
        TerminalReplay::new(successor_fence, 4, 20, TerminalReplayLimits::default()).unwrap();
    let recovered = RecoveredPresentation {
        source_fence: predecessor_snapshot.fence.clone(),
        sequence_through: predecessor_snapshot.sequence_through,
        captured_unix_ms: 10,
        truncated: predecessor_snapshot.truncated,
    };

    successor
        .restore_presentation(
            recovered.clone(),
            predecessor_snapshot.rows,
            predecessor_snapshot.columns,
            &predecessor_snapshot.repaint_bytes,
        )
        .unwrap();
    assert_eq!(successor.current_output_seq(), 0);
    assert_eq!(
        successor
            .ingest_output(b"after-reboot\r\n")
            .unwrap()
            .output_seq,
        1
    );

    let combined = successor.snapshot(ScreenSnapshotProfile::Full).unwrap();
    assert_eq!(combined.recovered_presentation, Some(Box::new(recovered)));
    assert_eq!(combined.sequence_through, 1);
    let mut restored = vt100::Parser::new(combined.rows, combined.columns, DEFAULT_SCROLLBACK_ROWS);
    restored.process(&combined.repaint_bytes);
    let contents = restored.screen().contents();
    assert!(contents.contains("before-reboot"));
    assert!(contents.contains("after-reboot"));
}

#[test]
fn canonical_snapshot_preserves_styled_visible_screen() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"plain \x1b[31mred\x1b[0m").unwrap();
    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 0);
    restored.process(&snapshot.repaint_bytes);

    assert_eq!(restored.screen().contents(), "plain red");
    assert_eq!(
        restored.screen().cell(0, 6).unwrap().fgcolor(),
        vt100::Color::Idx(1)
    );
    assert!(!snapshot.truncated);
}

#[test]
fn canonical_snapshot_preserves_styled_scrollback_rows() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    for line in 0..12 {
        replay
            .ingest_output(format!("history-{line:02} \x1b[31mred\x1b[0m\r\n").as_bytes())
            .unwrap();
    }

    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 100);
    restored.process(&snapshot.repaint_bytes);
    restored.screen_mut().set_scrollback(usize::MAX);

    assert!(restored.screen().contents().contains("history-00 red"));
    assert_eq!(
        restored.screen().cell(0, 11).unwrap().fgcolor(),
        vt100::Color::Idx(1)
    );
}

#[test]
fn canonical_snapshot_resets_style_between_formatted_history_rows() {
    let mut replay = TerminalReplay::new(fence(), 4, 10, TerminalReplayLimits::default()).unwrap();
    replay
        .ingest_output(b"\x1b[31mRED-SOFT-WRAP\x1b[39m\r\nPLAIN-NEXT\r\n")
        .unwrap();
    for line in 0..10 {
        replay
            .ingest_output(format!("tail-{line:02}\r\n").as_bytes())
            .unwrap();
    }

    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 100);
    restored.process(&snapshot.repaint_bytes);
    restored.screen_mut().set_scrollback(usize::MAX);

    assert_eq!(
        restored.screen().cell(0, 0).unwrap().fgcolor(),
        vt100::Color::Idx(1)
    );
    assert_eq!(
        restored.screen().cell(1, 0).unwrap().fgcolor(),
        vt100::Color::Idx(1)
    );
    assert_eq!(
        restored.screen().cell(2, 0).unwrap().fgcolor(),
        vt100::Color::Default
    );
    assert!(restored.screen().row_wrapped(0));
    assert!(!restored.screen().row_wrapped(1));
}

#[test]
fn canonical_snapshot_restores_bounded_scrollback_before_the_visible_screen() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    for line in 0..12 {
        replay
            .ingest_output(format!("history-{line:02}\r\n").as_bytes())
            .unwrap();
    }
    let visible_screen = replay.screen_contents();

    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 100);
    restored.process(&snapshot.repaint_bytes);

    assert_eq!(restored.screen().contents(), visible_screen);
    restored.screen_mut().set_scrollback(usize::MAX);
    assert!(restored.screen().scrollback() > 0);
    assert!(
        restored.screen().contents().contains("history-00"),
        "the oldest retained row should be reachable after hydration"
    );
    restored.screen_mut().set_scrollback(0);
    assert_eq!(restored.screen().contents(), visible_screen);
    assert!(snapshot.repaint_bytes.len() <= TerminalReplayLimits::default().max_snapshot_bytes);
    assert!(!snapshot.truncated);
}

#[test]
fn viewport_only_snapshot_skips_scrollback_and_advertises_its_profile() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    for line in 0..12 {
        replay
            .ingest_output(format!("history-{line:02}\r\n").as_bytes())
            .unwrap();
    }
    let visible_screen = replay.screen_contents();

    let snapshot = replay
        .snapshot(ScreenSnapshotProfile::ViewportOnly)
        .unwrap();
    let full = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    assert!(
        snapshot.repaint_bytes.len() < full.repaint_bytes.len(),
        "viewport-only must not pay for scrollback reconstruction"
    );
    assert_eq!(
        snapshot.actual_profile,
        Some(ScreenSnapshotProfile::ViewportOnly)
    );
    assert_eq!(full.actual_profile, None);
    assert!(!snapshot.truncated);
    assert_eq!(snapshot.sequence_through, full.sequence_through);

    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 100);
    restored.process(&snapshot.repaint_bytes);
    assert_eq!(restored.screen().contents(), visible_screen);
    restored.screen_mut().set_scrollback(usize::MAX);
    assert_eq!(
        restored.screen().scrollback(),
        0,
        "viewport-only hydration must not fabricate scrollback rows"
    );
}

#[test]
fn viewport_only_snapshot_with_empty_history_omits_nothing() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"prompt$ ").unwrap();
    let snapshot = replay
        .snapshot(ScreenSnapshotProfile::ViewportOnly)
        .unwrap();
    // 히스토리가 없으면 생략된 것도 없다 — 클라이언트가 무의미한 full
    // 스냅샷 hydrate 왕복을 돌지 않도록 프로필을 광고하지 않는다.
    assert_eq!(snapshot.actual_profile, None);
    assert_eq!(
        snapshot.repaint_bytes,
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .repaint_bytes
    );
}

#[test]
fn alternate_screen_snapshot_reports_no_omitted_history_for_any_profile() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"before-alt\r\n").unwrap();
    replay.ingest_output(b"\x1b[?1049h").unwrap();
    let snapshot = replay
        .snapshot(ScreenSnapshotProfile::ViewportOnly)
        .unwrap();
    // Alt-screen captures never include history regardless of profile, so
    // nothing was omitted and the client must not schedule an upgrade.
    assert!(snapshot.alternate_screen);
    assert_eq!(snapshot.actual_profile, None);
}

#[test]
fn shrinking_viewport_preserves_the_canonical_bottom_and_scrollback() {
    let mut replay =
        TerminalReplay::new(fence(), 30, 100, TerminalReplayLimits::default()).unwrap();
    for line in 1..=600 {
        replay
            .ingest_output(
                format!("HMUX_SCROLL_QA_LINE_{line:04} canonical-history\r\n").as_bytes(),
            )
            .unwrap();
    }
    let marker = b"HMUX_SCROLL_QA_0123456789AB_READY";
    replay.ingest_output(marker).unwrap();
    replay.ingest_output(b"\x1b[?1h\x1b[?2004h").unwrap();
    assert!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .repaint_bytes
            .windows(marker.len())
            .any(|window| window == marker)
    );

    replay.resize(19, 67).unwrap();
    let resized = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();

    assert_eq!((resized.rows, resized.columns), (19, 67));
    assert!(replay.terminal.application_cursor());
    assert!(replay.terminal.bracketed_paste());
    replay.ingest_output(b"_AFTER_RESIZE").unwrap();
    assert!(
        replay
            .screen_contents()
            .contains("HMUX_SCROLL_QA_0123456789AB_READY_AFTER_RESIZE")
    );
    assert!(
        resized
            .repaint_bytes
            .windows(marker.len())
            .any(|window| window == marker)
    );
    let mut restored = vt100::Parser::new(19, 67, 1_000);
    restored.process(&resized.repaint_bytes);
    restored.screen_mut().set_scrollback(usize::MAX);
    assert!(restored.screen().scrollback() >= 500);
}

#[test]
fn repeated_resize_preserves_soft_wrapped_history_as_one_logical_line() {
    let mut replay = TerminalReplay::new(fence(), 4, 12, TerminalReplayLimits::default()).unwrap();
    // The first wrap lands after an explicit space, and the transcript
    // also contains a wide glyph. Both are common in rendered agent
    // output and must survive the same logical-line reconstruction.
    let transcript =
        "12345678901 SOFT_WRAP_한글_TRANSCRIPT_SHOULD_REMAIN_ONE_LOGICAL_LINE_ACROSS_EVERY_RESIZE";
    replay
        .ingest_output(format!("{transcript}\r\n").as_bytes())
        .unwrap();
    for line in 0..80 {
        replay
            .ingest_output(format!("tail-{line:02}\r\n").as_bytes())
            .unwrap();
    }

    for (rows, columns) in [(6, 19), (5, 9), (8, 27), (4, 13)] {
        replay.resize(rows, columns).unwrap();
    }

    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 5_000);
    restored.process(&snapshot.repaint_bytes);
    let mut view = restored.screen().clone();
    view.set_scrollback(usize::MAX);
    let retained_rows = view.scrollback();
    let columns = view.size().1;
    let mut logical_history = String::new();
    for offset in (1..=retained_rows).rev() {
        view.set_scrollback(offset);
        logical_history.push_str(&view.rows(0, columns).next().unwrap_or_default());
        if !view.row_wrapped(0) {
            logical_history.push('\n');
        }
    }

    assert!(
        logical_history.contains(transcript),
        "soft-wrapped transcript acquired hard line breaks after resize:\n{logical_history}"
    );
}

#[test]
fn widening_a_codex_like_transcript_does_not_create_physical_history_rows() {
    let mut replay = TerminalReplay::new(fence(), 22, 62, TerminalReplayLimits::default()).unwrap();
    for line in 0..1_200 {
        let style = match line % 4 {
            0 => "\x1b[38;5;75m",
            1 => "\x1b[1;32m",
            2 => "\x1b[3;33m",
            _ => "\x1b[0m",
        };
        replay
            .ingest_output(
                format!(
                    "{style}{line:04} │ 작업 결과 mixed Unicode 한글 · branch-{line:04}\x1b[0m\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
    }
    replay.ingest_output(b"\x1b[?1h\x1b[?2004hINPUT> ").unwrap();

    let before = replay.terminal.retained_physical_rows();

    for _ in 0..4 {
        replay.resize(22, 75).unwrap();
        assert!(
            replay.terminal.retained_physical_rows() <= before,
            "widening must not manufacture physical history rows"
        );
        replay.resize(22, 43).unwrap();
        replay.resize(22, 62).unwrap();
    }
    let after = replay.terminal.retained_physical_rows();
    assert_eq!(
        after, before,
        "resize cycles changed canonical physical history from {before} to {after}"
    );
    assert!(replay.screen_contents().contains("INPUT> "));
    assert!(replay.terminal.application_cursor());
    assert!(replay.terminal.bracketed_paste());

    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let canonical_viewport = replay.screen_contents();
    let canonical_cursor = replay.terminal.cursor_position();
    let mut restored = vt100::Parser::new(snapshot.rows, snapshot.columns, 5_000);
    restored.process(&snapshot.repaint_bytes);
    assert_eq!(restored.screen().contents(), canonical_viewport);
    assert_eq!(restored.screen().cursor_position(), canonical_cursor);
    assert!(restored.screen().application_cursor());
    assert!(restored.screen().bracketed_paste());
}

#[test]
fn resizing_preserves_alternate_screen_content_and_input_modes() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"MAIN_BOTTOM").unwrap();
    replay
        .ingest_output(b"\x1b[?1049h\x1b[H\x1b[?1h\x1b[?2004hALT_BOTTOM")
        .unwrap();

    replay.resize(3, 16).unwrap();

    assert!(replay.terminal.alternate_screen());
    assert!(replay.terminal.application_cursor());
    assert!(replay.terminal.bracketed_paste());
    assert!(
        replay.screen_contents().contains("ALT_BOTTOM"),
        "alternate content after resize: {:?}",
        replay.screen_contents()
    );
    replay.ingest_output(b"_TAIL").unwrap();
    assert!(replay.screen_contents().contains("ALT_BOTTOM_TAIL"));
    replay.ingest_output(b"\x1b[?1049l").unwrap();
    assert!(
        replay.screen_contents().contains("MAIN_BOTTOM"),
        "resizing alternate screen must not discard the inactive main grid"
    );
}

#[test]
#[ignore = "structured-terminal cutover blocker: ANSI repaint cannot encode the inactive normal grid while alternate screen is active"]
fn active_alternate_checkpoint_restores_the_inactive_normal_screen() {
    let mut predecessor = replay_with_limits(TerminalReplayLimits::default());
    predecessor
        .ingest_output(b"NORMAL_HISTORY_MARKER\r\n")
        .unwrap();
    predecessor
        .ingest_output(b"\x1b[?1049h\x1b[HCLAUDE_ALT_MARKER")
        .unwrap();
    let checkpoint = predecessor.snapshot(ScreenSnapshotProfile::Full).unwrap();
    assert!(checkpoint.alternate_screen);

    let recovered = RecoveredPresentation {
        source_fence: checkpoint.fence.clone(),
        sequence_through: checkpoint.sequence_through,
        captured_unix_ms: 10,
        truncated: checkpoint.truncated,
    };
    let mut successor_fence = fence();
    successor_fence.runner_instance = "runner-2".into();
    successor_fence.host_instance_id = "host-2".into();
    successor_fence.terminal_epoch = "terminal-2".into();
    let mut successor = TerminalReplay::new(
        successor_fence,
        checkpoint.rows,
        checkpoint.columns,
        TerminalReplayLimits::default(),
    )
    .unwrap();
    successor
        .restore_presentation(
            recovered,
            checkpoint.rows,
            checkpoint.columns,
            &checkpoint.repaint_bytes,
        )
        .unwrap();

    assert!(
        successor
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .alternate_screen
    );
    successor.ingest_output(b"\x1b[?1049l").unwrap();
    assert!(
        successor
            .screen_contents()
            .contains("NORMAL_HISTORY_MARKER"),
        "an active-alt checkpoint must retain the inactive normal grid"
    );
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn native_terminal_checkpoint_rehosts_both_normal_and_alternate_buffers() {
    let mut predecessor =
        TerminalReplay::new(fence(), 12, 80, TerminalReplayLimits::default()).unwrap();
    predecessor
        .ingest_output(b"NORMAL_HISTORY_MARKER\r\n")
        .unwrap();
    predecessor
        .ingest_output(b"\x1b[?1049h\x1b[HCODEX_ALT_MARKER")
        .unwrap();
    let checkpoint = predecessor.checkpoint().unwrap();
    assert!(checkpoint.alternate_screen);

    let recovered = RecoveredPresentation {
        source_fence: checkpoint.fence.clone(),
        sequence_through: checkpoint.sequence_through,
        captured_unix_ms: 10,
        truncated: false,
    };
    let mut successor_fence = fence();
    successor_fence.runner_instance = "runner-2".into();
    successor_fence.host_instance_id = "host-2".into();
    successor_fence.terminal_epoch = "terminal-2".into();
    let mut successor = TerminalReplay::new(
        successor_fence,
        checkpoint.rows,
        checkpoint.columns,
        TerminalReplayLimits::default(),
    )
    .unwrap();
    successor.restore_checkpoint(recovered, checkpoint).unwrap();

    assert!(successor.screen_contents().contains("CODEX_ALT_MARKER"));
    successor.ingest_output(b"\x1b[?1049l").unwrap();
    assert!(
        successor
            .screen_contents()
            .contains("NORMAL_HISTORY_MARKER"),
        "native checkpoint must preserve the inactive normal buffer"
    );
}

#[test]
fn bounded_history_and_output_free_resize_have_exact_canonical_observations() {
    let mut replay = TerminalReplay::new(fence(), 4, 40, TerminalReplayLimits::default()).unwrap();
    for chunk in 0..100 {
        let mut output = String::new();
        for offset in 0..1_000 {
            let line = chunk * 1_000 + offset;
            output.push_str(&format!("CODEX_HISTORY_{line:06}\r\n"));
        }
        replay.ingest_output(output.as_bytes()).unwrap();
    }

    let before_resize_seq = replay.current_output_seq();
    let before_resize_revision = replay.current_terminal_state_revision();
    #[cfg(feature = "ghostty-core-proof")]
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !replay.reconcile_terminal_history().unwrap() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    replay.resize(7, 60).unwrap();
    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();

    assert_eq!(snapshot.sequence_through, before_resize_seq);
    assert_eq!(
        replay.current_terminal_state_revision(),
        before_resize_revision + 1,
        "an output-free geometry mutation must advance canonical state revision"
    );
    assert_eq!((snapshot.rows, snapshot.columns), (7, 60));
    assert!(
        snapshot
            .repaint_bytes
            .windows(b"CODEX_HISTORY_099999".len())
            .any(|window| window == b"CODEX_HISTORY_099999")
    );
    assert!(
        !snapshot
            .repaint_bytes
            .windows(b"CODEX_HISTORY_000000".len())
            .any(|window| window == b"CODEX_HISTORY_000000"),
        "bounded history must prune the oldest row"
    );
    assert!(
        replay.terminal.retained_physical_rows()
            <= TerminalReplayLimits::default().max_history_logical_lines + 7
    );
}

#[test]
#[cfg(feature = "ghostty-core-proof")]
fn history_capacity_failure_does_not_block_terminal_liveness() {
    assert_eq!(
        TerminalReplayLimits::default().max_history_logical_lines,
        20_000
    );
    let mut replay = TerminalReplay::new(
        fence(),
        4,
        40,
        TerminalReplayLimits {
            max_pending_history_transfer_bytes: 1,
            ..TerminalReplayLimits::default()
        },
    )
    .unwrap();

    let first = replay
        .ingest_output(b"HISTORY_CAPACITY_FAILURE\r\n")
        .expect("history retention must not reject an already-readable PTY batch");
    assert_eq!(first.output_seq, 1);
    assert!(matches!(
        first.history_degradation,
        Some(TerminalReplayError::HistoryStorageBackpressure { .. })
    ));
    assert!(!replay.history_transfer.is_enabled());
    assert!(
        replay
            .screen_contents()
            .contains("HISTORY_CAPACITY_FAILURE")
    );

    replay.resize(6, 60).unwrap();
    let second = replay
        .ingest_output(b"OUTPUT_AFTER_HISTORY_FAILURE\r\n")
        .expect("the same terminal epoch must keep ingesting provider output");
    assert_eq!(second.output_seq, 2);
    assert_eq!(second.history_degradation, None);

    let mut projection = replay.attach_view_projection().unwrap();
    let frame = replay
        .capture_latest_viewport_frame(&mut projection)
        .unwrap()
        .expect("history truncation must still publish one complete viewport frame")
        .finish()
        .unwrap();
    assert_eq!(frame.through_output_seq, 2);
    assert_eq!(
        frame.state_revision,
        replay.current_terminal_state_revision()
    );
    assert_eq!(replay.terminal.size(), (6, 60));
    assert!(
        replay
            .screen_contents()
            .contains("OUTPUT_AFTER_HISTORY_FAILURE")
    );
}

#[test]
fn terminal_state_revision_exhaustion_precedes_canonical_mutation() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"stable-before-exhaustion").unwrap();
    let before_contents = replay.screen_contents();
    let before_output_seq = replay.current_output_seq();
    replay.terminal_state_revision = u64::MAX;

    assert_eq!(
        replay.ingest_output(b"MUST_NOT_APPEAR"),
        Err(TerminalReplayError::TerminalStateRevisionExhausted)
    );
    assert_eq!(replay.screen_contents(), before_contents);
    assert_eq!(replay.current_output_seq(), before_output_seq);
    assert_eq!(replay.current_terminal_state_revision(), u64::MAX);
}

#[test]
fn prepared_resize_reserves_revision_before_canonical_mutation() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.terminal_state_revision = u64::MAX - 1;
    let previous_size = replay.terminal.size();

    let prepared = replay.prepare_resize(7, 60).unwrap();
    assert_eq!(replay.terminal.size(), previous_size);
    assert_eq!(replay.current_terminal_state_revision(), u64::MAX - 1);
    replay.terminal_state_revision = u64::MAX;

    assert_eq!(replay.commit_resize(prepared).unwrap(), None);

    assert_eq!(replay.terminal.size(), (7, 60));
    assert_eq!(replay.current_terminal_state_revision(), u64::MAX);
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn resize_does_not_require_a_checkpointable_parser_continuation() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let mut partial_osc = b"\x1b]0;".to_vec();
    partial_osc.extend(std::iter::repeat_n(b'x', 4_097));
    replay.ingest_output(&partial_osc).unwrap();

    replay.resize(7, 60).unwrap();
    replay
        .ingest_output(b"\x07OUTPUT_AFTER_CONTINUATION_RESIZE")
        .unwrap();

    assert_eq!(replay.terminal.size(), (7, 60));
    assert!(
        replay
            .screen_contents()
            .contains("OUTPUT_AFTER_CONTINUATION_RESIZE")
    );
}

#[test]
fn recovered_presentation_resize_commits_one_revision_at_max_minus_one() {
    let mut predecessor =
        TerminalReplay::new(fence(), 2, 10, TerminalReplayLimits::default()).unwrap();
    predecessor.ingest_output(b"RECOVERED").unwrap();
    let snapshot = predecessor.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let recovered = RecoveredPresentation {
        source_fence: snapshot.fence.clone(),
        sequence_through: snapshot.sequence_through,
        captured_unix_ms: 10,
        truncated: snapshot.truncated,
    };
    let mut successor_fence = fence();
    successor_fence.runner_instance = "runner-2".into();
    successor_fence.host_instance_id = "host-2".into();
    successor_fence.terminal_epoch = "terminal-2".into();
    let mut successor =
        TerminalReplay::new(successor_fence, 4, 20, TerminalReplayLimits::default()).unwrap();
    successor.terminal_state_revision = u64::MAX - 1;

    successor
        .restore_presentation(
            recovered.clone(),
            snapshot.rows,
            snapshot.columns,
            &snapshot.repaint_bytes,
        )
        .unwrap();

    assert_eq!(successor.current_terminal_state_revision(), u64::MAX);
    assert_eq!(successor.terminal.size(), (4, 20));
    assert_eq!(successor.pending_output_geometry, Some((4, 20)));
    assert_eq!(successor.recovered_presentation, Some(recovered));
    assert!(successor.screen_contents().contains("RECOVERED"));
}

#[test]
fn recovered_presentation_revision_exhaustion_leaves_all_state_unchanged() {
    let mut predecessor =
        TerminalReplay::new(fence(), 2, 10, TerminalReplayLimits::default()).unwrap();
    predecessor.ingest_output(b"RECOVERED").unwrap();
    let snapshot = predecessor.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let recovered = RecoveredPresentation {
        source_fence: snapshot.fence.clone(),
        sequence_through: snapshot.sequence_through,
        captured_unix_ms: 10,
        truncated: snapshot.truncated,
    };
    let mut successor_fence = fence();
    successor_fence.runner_instance = "runner-2".into();
    successor_fence.host_instance_id = "host-2".into();
    successor_fence.terminal_epoch = "terminal-2".into();
    let mut successor =
        TerminalReplay::new(successor_fence, 4, 20, TerminalReplayLimits::default()).unwrap();
    let before_contents = successor.screen_contents();
    let before_size = successor.terminal.size();
    let before_pending_geometry = successor.pending_output_geometry;
    successor.terminal_state_revision = u64::MAX;

    assert_eq!(
        successor.restore_presentation(
            recovered,
            snapshot.rows,
            snapshot.columns,
            &snapshot.repaint_bytes,
        ),
        Err(TerminalReplayError::TerminalStateRevisionExhausted)
    );
    assert_eq!(successor.current_terminal_state_revision(), u64::MAX);
    assert_eq!(successor.screen_contents(), before_contents);
    assert_eq!(successor.terminal.size(), before_size);
    assert_eq!(successor.pending_output_geometry, before_pending_geometry);
    assert_eq!(successor.recovered_presentation, None);
}

#[test]
fn launch_cwd_is_fenced_into_the_initial_snapshot() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());

    assert!(
        replay
            .observe_working_directory(WorkingDirectoryObservation::new(
                "/workspace",
                WorkingDirectorySource::LaunchFallback,
            ))
            .unwrap()
    );
    let snapshot = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    let cwd = snapshot.working_directory.unwrap();

    assert_eq!(cwd.terminal_epoch, "terminal-1");
    assert_eq!(cwd.observed_through_output_seq, 0);
    assert_eq!(cwd.path, "/workspace");
    assert_eq!(cwd.source, WorkingDirectorySource::LaunchFallback);
}

#[test]
fn agent_identity_distinguishes_shell_from_detected_agent() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());

    assert!(
        replay
            .observe_agent_identity(AgentIdentityObservation::process_inspection(None))
            .unwrap()
    );
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_identity
            .unwrap()
            .agent,
        None
    );

    assert!(
        replay
            .observe_agent_identity(AgentIdentityObservation::process_inspection(Some(
                crate::local_protocol::AgentProvider::Codex,
            )))
            .unwrap()
    );
    let projection = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_identity
        .unwrap();
    assert_eq!(projection.terminal_epoch, "terminal-1");
    assert_eq!(projection.observed_through_output_seq, 0);
    assert_eq!(
        projection.agent,
        Some(crate::local_protocol::AgentProvider::Codex)
    );
}

#[test]
fn provider_conversation_identity_is_fenced_immutable_and_opaque() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let first = replay
        .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::LaunchRequest,
        ))
        .unwrap()
        .unwrap();
    assert_eq!(first.fence, fence());
    assert_eq!(first.revision, 1);
    assert_eq!(first.observed_through_output_seq, 0);

    assert!(
        replay
            .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
                "codex",
                "conversation-1",
                ProviderConversationIdentitySource::LaunchRequest,
            ),)
            .unwrap()
            .is_none()
    );
    let confirmed = replay
        .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::ProviderEvent,
        ))
        .unwrap()
        .expect("a provider event confirms the launch-request identity");
    assert_eq!(confirmed.revision, 2);
    assert_eq!(
        confirmed.source,
        ProviderConversationIdentitySource::ProviderEvent
    );
    assert!(
        replay
            .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
                "codex",
                "conversation-1",
                ProviderConversationIdentitySource::LaunchRequest,
            ))
            .unwrap()
            .is_none(),
        "a later launch hint cannot downgrade provider-confirmed identity"
    );
    assert_eq!(
        replay.observe_provider_conversation_identity(
            ProviderConversationIdentityObservation::new(
                "codex",
                "conversation-2",
                ProviderConversationIdentitySource::ProviderEvent,
            ),
        ),
        Err(TerminalReplayError::ProviderConversationIdentityConflict)
    );
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .provider_conversation_identity,
        Some(Box::new(confirmed))
    );
    assert_eq!(
        replay.observe_provider_conversation_identity(
            ProviderConversationIdentityObservation::new(
                "codex",
                "unsafe;command",
                ProviderConversationIdentitySource::ProviderEvent,
            ),
        ),
        Err(TerminalReplayError::InvalidProviderConversationIdentity)
    );
}

#[test]
fn agent_runtime_revisions_change_only_with_typed_semantics_and_keep_attention_identity() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let working = AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput);
    let first = replay
        .observe_agent_runtime_state(working)
        .unwrap()
        .unwrap();
    assert_eq!(first.revision, 1);
    assert!(
        replay
            .observe_agent_runtime_state(working)
            .unwrap()
            .is_none()
    );

    replay.ingest_output(b"approval prompt").unwrap();
    let approval = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
                false,
            ))
            .unwrap(),
    );
    let corroborated = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
                true,
            ))
            .unwrap(),
    );

    assert_eq!(approval.revision, 2);
    assert_eq!(approval.observed_through_output_seq, 1);
    assert_eq!(approval.attention_id, corroborated.attention_id);
    assert_eq!(corroborated.revision, 3);
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_runtime_state,
        Some(corroborated)
    );
}

#[test]
fn process_waiting_only_seeds_an_absent_runtime_projection() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeLifecycle, AgentRuntimeStateSource,
    };

    let process_waiting =
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle);
    let mut baseline = replay_with_limits(TerminalReplayLimits::default());
    let seeded = baseline
        .observe_agent_runtime_state(process_waiting)
        .unwrap()
        .expect("process discovery seeds an otherwise unknown runtime");
    assert_eq!(seeded.activity, AgentRuntimeActivity::Waiting);

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let working = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Working,
                crate::local_protocol::AgentRuntimeAttention::None,
                false,
            ))
            .unwrap(),
    );
    assert!(
        replay
            .observe_agent_runtime_state(process_waiting)
            .unwrap()
            .is_none()
    );
    assert_eq!(replay.agent_runtime_state.as_ref(), Some(&working));

    let mut pending = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let mut completion = state_report(
        AgentRuntimeActivity::Waiting,
        crate::local_protocol::AgentRuntimeAttention::None,
        true,
    );
    completion.turn_completion_id = Some("completion-before-process-scan".to_string());
    assert_eq!(
        pending
            .apply_agent_state_report_at(completion, started_at)
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(
        pending
            .observe_agent_runtime_state(process_waiting)
            .unwrap()
            .is_none(),
        "a weak process baseline must not supersede an admitted provider fact"
    );
    assert_eq!(
        pending
            .expire_agent_runtime_state(started_at + Duration::from_secs(1))
            .unwrap()
            .expect("the provider completion still settles")
            .turn_completed_count,
        1
    );

    let exited = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::exited())
        .unwrap()
        .expect("process exit remains authoritative");
    assert_eq!(exited.lifecycle, AgentRuntimeLifecycle::Exited);
}

#[test]
fn inconsistent_agent_runtime_observation_is_rejected_without_advancing_revision() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateSource,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let invalid = AgentRuntimeObservation::new(
        AgentRuntimeLifecycle::Running,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::InputRequired,
        AgentRuntimeStateSource::ControllerInput,
    );

    assert_eq!(
        replay.observe_agent_runtime_state(invalid),
        Err(TerminalReplayError::InvalidAgentRuntimeState)
    );
    assert!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_runtime_state
            .is_none()
    );
}

#[test]
fn pty_output_never_mutates_working_directory_projection() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .observe_working_directory(WorkingDirectoryObservation::new(
            "/workspace",
            WorkingDirectorySource::LaunchFallback,
        ))
        .unwrap();

    let delta = replay
        .ingest_output(b"\x1b]7;file:///forged\x07prompt")
        .unwrap();
    assert!(
        delta.working_directory.is_none(),
        "PTY bytes are presentation and must not publish a cwd runtime fact"
    );
    let after_output = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .working_directory
        .unwrap();
    assert_eq!(after_output.path, "/workspace");
    assert_eq!(after_output.source, WorkingDirectorySource::LaunchFallback);

    assert!(
        replay
            .observe_working_directory(WorkingDirectoryObservation::new(
                "/workspace/src",
                WorkingDirectorySource::ProcessInspection,
            ))
            .unwrap()
    );
    let inspected = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .working_directory
        .unwrap();
    assert_eq!(inspected.path, "/workspace/src");
    assert_eq!(inspected.source, WorkingDirectorySource::ProcessInspection);
}

#[test]
fn execution_location_change_ignores_observation_fence_progression() {
    // 2026-08-05 storm regression: the 750ms identity poll re-observes the
    // location while output streams; observed_through_output_seq advances
    // between polls, and a whole-projection compare reported "changed" every
    // poll — broadcasting a full screen snapshot (~700KiB clear+rewrite) to
    // every subscriber, per poll, for every streaming session.
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    assert!(
        replay
            .observe_execution_location(ExecutionLocationObservation::local())
            .unwrap()
    );
    replay.ingest_output(b"streaming output").unwrap();
    assert!(
        !replay
            .observe_execution_location(ExecutionLocationObservation::local())
            .unwrap()
    );
    replay.ingest_output(b"more streaming output").unwrap();
    assert!(
        !replay
            .observe_execution_location(ExecutionLocationObservation::local())
            .unwrap()
    );
    // Store-but-suppress: the observation fence keeps advancing even when the
    // change report is suppressed — later deltas carry the fresh freshness fact.
    let delta = replay.ingest_output(b"post-suppression output").unwrap();
    assert_eq!(
        delta
            .execution_location
            .as_ref()
            .unwrap()
            .observed_through_output_seq,
        delta.output_seq - 1
    );
    // A genuine location change still reports.
    assert!(
        replay
            .observe_execution_location(ExecutionLocationObservation::ssh("rts@211.181.122.124"))
            .unwrap()
    );
}

#[test]
fn execution_location_is_fenced_and_clears_back_to_local() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    assert!(
        replay
            .observe_execution_location(ExecutionLocationObservation::local())
            .unwrap()
    );
    assert!(
        !replay
            .observe_execution_location(ExecutionLocationObservation::local())
            .unwrap()
    );
    assert!(
        replay
            .observe_execution_location(ExecutionLocationObservation::ssh("rts@211.181.122.124",))
            .unwrap()
    );

    let delta = replay.ingest_output(b"remote prompt").unwrap();
    let projected = delta.delta.execution_location.as_ref().unwrap();
    assert_eq!(projected.terminal_epoch, delta.terminal_epoch);
    assert!(matches!(
        projected.location,
        ExecutionLocation::Ssh { ref target } if target == "rts@211.181.122.124"
    ));
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .execution_location
            .as_ref(),
        Some(projected)
    );

    replay
        .observe_execution_location(ExecutionLocationObservation::local())
        .unwrap();
    assert!(matches!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .execution_location
            .unwrap()
            .location,
        ExecutionLocation::Local
    ));
}

#[test]
fn unsafe_execution_target_is_rejected_without_replacing_current_fact() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .observe_execution_location(ExecutionLocationObservation::local())
        .unwrap();

    assert_eq!(
        replay.observe_execution_location(ExecutionLocationObservation::ssh("bad target")),
        Err(TerminalReplayError::InvalidExecutionLocation)
    );
    assert!(matches!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .execution_location
            .unwrap()
            .location,
        ExecutionLocation::Local
    ));
}

#[test]
fn unchanged_cwd_is_not_repeated_in_every_delta() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .observe_working_directory(WorkingDirectoryObservation::new(
            "/workspace",
            WorkingDirectorySource::ProcessInspection,
        ))
        .unwrap();

    assert!(
        !replay
            .observe_working_directory(WorkingDirectoryObservation::new(
                "/workspace",
                WorkingDirectorySource::ProcessInspection,
            ))
            .unwrap()
    );
    let delta = replay.ingest_output(b"prompt").unwrap();

    assert!(delta.working_directory.is_none());
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .working_directory
            .unwrap()
            .observed_through_output_seq,
        0
    );
}

#[test]
fn invalid_external_cwd_does_not_advance_terminal_state() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());

    assert_eq!(
        replay.observe_working_directory(WorkingDirectoryObservation::new(
            "/bad\npath",
            WorkingDirectorySource::ProcessInspection,
        )),
        Err(TerminalReplayError::InvalidWorkingDirectory)
    );
    assert_eq!(replay.current_output_seq(), 0);
    assert!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .working_directory
            .is_none()
    );
}

fn state_report(
    activity: AgentRuntimeActivity,
    attention: AgentRuntimeAttention,
    turn_completed: bool,
) -> AgentStateReportObservation {
    AgentStateReportObservation {
        activity,
        attention,
        turn_completed,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        expected_observation: None,
    }
}

fn applied(fold: AgentStateReportFold) -> AgentRuntimeStateProjection {
    let AgentStateReportFold::Applied(projection) = fold else {
        panic!("expected the report to apply, got {fold:?}");
    };
    projection
}

fn provider_ready_for_agent_prompt() -> (TerminalReplay, AgentRuntimeStateProjection) {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::ProviderEvent,
        ))
        .unwrap();
    let runtime = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap()
        .unwrap();
    (replay, runtime)
}

fn fresh_agent_prompt_target() -> AgentPromptTarget {
    AgentPromptTarget::FreshAgent
}

fn process_observed_fresh_agent_prompt_target(provider_id: &str) -> AgentPromptTarget {
    AgentPromptTarget::ProcessObservedFreshAgent {
        expected_provider_id: provider_id.into(),
    }
}

fn existing_conversation_prompt_target() -> AgentPromptTarget {
    AgentPromptTarget::ExistingConversation {
        expected_provider_id: "codex".into(),
        expected_conversation_id: "conversation-1".into(),
    }
}

#[test]
fn fresh_agent_prompt_uses_provider_readiness_before_a_conversation_exists() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let target = fresh_agent_prompt_target();
    let runtime = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap()
        .unwrap();

    assert!(replay.provider_conversation_identity().is_none());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
    assert_eq!(replay.prepare_agent_prompt(&target), Some(runtime.revision));
    assert_eq!(
        replay.agent_prompt_admission(&existing_conversation_prompt_target()),
        AgentPromptAdmission::Refused
    );

    replay
        .apply_agent_state_report(state_report(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
            false,
        ))
        .unwrap();
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
}

#[test]
fn identityless_fresh_prompt_bootstraps_from_the_host_observed_agent_process() {
    let mut runtime_without_agent = replay_with_limits(TerminalReplayLimits::default());
    runtime_without_agent
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap();
    assert_eq!(
        runtime_without_agent
            .agent_prompt_admission(&process_observed_fresh_agent_prompt_target("codex")),
        AgentPromptAdmission::Pending,
        "a process-lifecycle hint without an observed agent is not prompt authority"
    );

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .observe_agent_identity(AgentIdentityObservation::process_inspection(Some(
            AgentProvider::Codex,
        )))
        .unwrap();
    let runtime = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap()
        .expect("the first exact agent process observation seeds runtime state");
    let strict = fresh_agent_prompt_target();
    let process_bootstrap = process_observed_fresh_agent_prompt_target("codex");

    assert_eq!(
        replay.agent_prompt_admission(&strict),
        AgentPromptAdmission::Pending,
        "ordinary FreshAgent keeps provider-event readiness semantics"
    );
    assert_eq!(
        replay.agent_prompt_admission(&process_bootstrap),
        AgentPromptAdmission::Eligible,
        "the explicit process-observed target can bootstrap the first conversation"
    );
    assert_eq!(
        replay.prepare_agent_prompt(&process_bootstrap),
        Some(runtime.revision)
    );
    assert_eq!(
        replay.agent_prompt_admission(&process_observed_fresh_agent_prompt_target("claude")),
        AgentPromptAdmission::Pending,
        "a different observed provider cannot satisfy the launch provider"
    );
    replay
        .observe_agent_identity(AgentIdentityObservation::process_inspection(Some(
            AgentProvider::Claude,
        )))
        .unwrap();
    assert_eq!(
        replay.agent_prompt_admission(&process_observed_fresh_agent_prompt_target("claude")),
        AgentPromptAdmission::Eligible,
        "replaceable process identity can converge to the launch provider"
    );
    assert_eq!(
        replay.agent_prompt_admission(&existing_conversation_prompt_target()),
        AgentPromptAdmission::Refused,
        "process inspection never authorizes an existing conversation target"
    );
}

#[test]
fn process_observed_fresh_prompt_preserves_the_existing_readiness_fences() {
    let target = process_observed_fresh_agent_prompt_target("codex");
    let replay_for = |runtime| {
        let mut replay = replay_with_limits(TerminalReplayLimits::default());
        replay
            .observe_agent_identity(AgentIdentityObservation::process_inspection(Some(
                AgentProvider::Codex,
            )))
            .unwrap();
        if let Some(runtime) = runtime {
            replay.observe_agent_runtime_state(runtime).unwrap();
        }
        replay
    };

    assert_eq!(
        replay_for(None).agent_prompt_admission(&target),
        AgentPromptAdmission::Pending,
    );
    for (runtime, expected) in [
        (
            AgentRuntimeObservation::new(
                AgentRuntimeLifecycle::Starting,
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                AgentRuntimeStateSource::ProcessLifecycle,
            ),
            AgentPromptAdmission::Pending,
        ),
        (
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ProcessLifecycle),
            AgentPromptAdmission::Refused,
        ),
        (
            AgentRuntimeObservation::new(
                AgentRuntimeLifecycle::Running,
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::InputRequired,
                AgentRuntimeStateSource::ProcessLifecycle,
            ),
            AgentPromptAdmission::Refused,
        ),
        (
            AgentRuntimeObservation::exited(),
            AgentPromptAdmission::Refused,
        ),
    ] {
        assert_eq!(
            replay_for(Some(runtime)).agent_prompt_admission(&target),
            expected
        );
    }

    let mut prior_input = replay_for(Some(AgentRuntimeObservation::waiting(
        AgentRuntimeStateSource::ProcessLifecycle,
    )));
    prior_input.record_controller_write();
    assert_eq!(
        prior_input.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused,
    );

    let (provider_ready, _) = provider_ready_for_agent_prompt();
    assert_eq!(
        provider_ready.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible,
        "provider-event readiness remains stronger than the bootstrap path",
    );
}

#[test]
fn fresh_agent_prompt_preparation_commits_only_after_written_input() {
    let (mut replay, runtime) = provider_ready_for_agent_prompt();
    let target = fresh_agent_prompt_target();

    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
    assert_eq!(replay.prepare_agent_prompt(&target), Some(runtime.revision));
    // Preparation is read-only so a proven zero-byte writer failure can retry.
    assert!(!replay.has_pending_controller_input());
    assert_eq!(replay.prepare_agent_prompt(&target), Some(runtime.revision));

    replay.record_controller_input();
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
    assert_eq!(replay.prepare_agent_prompt(&target), None);
}

#[test]
fn fresh_agent_prompt_admission_rejects_every_non_provider_ready_projection() {
    let target = fresh_agent_prompt_target();
    let missing_startup = replay_with_limits(TerminalReplayLimits::default());
    assert_eq!(
        missing_startup.agent_prompt_admission(&target),
        AgentPromptAdmission::Pending
    );
    assert_eq!(missing_startup.prepare_agent_prompt(&target), None);

    let mut launch_hints = replay_with_limits(TerminalReplayLimits::default());
    launch_hints
        .observe_provider_conversation_identity(ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::LaunchRequest,
        ))
        .unwrap();
    launch_hints
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap();
    assert_eq!(
        launch_hints.agent_prompt_admission(&target),
        AgentPromptAdmission::Pending
    );
    assert_eq!(launch_hints.prepare_agent_prompt(&target), None);

    let (mut working, _) = provider_ready_for_agent_prompt();
    working
        .observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap();
    assert_eq!(
        working.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
    assert_eq!(working.prepare_agent_prompt(&target), None);

    let (mut attention, _) = provider_ready_for_agent_prompt();
    attention
        .apply_agent_state_report(state_report(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
            false,
        ))
        .unwrap();
    assert_eq!(
        attention.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
    assert_eq!(attention.prepare_agent_prompt(&target), None);

    let (mut prior_input, _) = provider_ready_for_agent_prompt();
    prior_input.record_controller_input();
    prior_input
        .observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ControllerInput,
        ))
        .unwrap();
    prior_input
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap();
    assert!(!prior_input.has_pending_controller_input());
    assert_eq!(
        prior_input.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
    assert_eq!(prior_input.prepare_agent_prompt(&target), None);
}

#[test]
fn existing_conversation_prompt_refuses_missing_or_mismatched_identity_immediately() {
    let target = existing_conversation_prompt_target();
    let missing = replay_with_limits(TerminalReplayLimits::default());
    assert_eq!(
        missing.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    let (replay, _) = provider_ready_for_agent_prompt();
    for mismatched in [
        AgentPromptTarget::ExistingConversation {
            expected_provider_id: "claude".into(),
            expected_conversation_id: "conversation-1".into(),
        },
        AgentPromptTarget::ExistingConversation {
            expected_provider_id: "codex".into(),
            expected_conversation_id: "conversation-2".into(),
        },
    ] {
        assert_eq!(
            replay.agent_prompt_admission(&mismatched),
            AgentPromptAdmission::Refused
        );
    }
}

#[test]
fn turn_completed_reports_bump_revision_and_count_even_when_unchanged() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let working = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    let first = applied(replay.apply_agent_state_report(working.clone()).unwrap());
    assert_eq!(first.revision, 1);
    assert_eq!(first.turn_completed_count, 0);
    assert_eq!(
        replay.apply_agent_state_report(working).unwrap(),
        AgentStateReportFold::NoOp
    );

    let completed = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        true,
    );
    let second = applied(replay.apply_agent_state_report(completed.clone()).unwrap());
    assert_eq!(second.revision, 2);
    assert_eq!(second.turn_completed_count, 1);
    let third = applied(replay.apply_agent_state_report(completed).unwrap());
    assert_eq!(third.revision, 3);
    assert_eq!(third.turn_completed_count, 2);
    assert_eq!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_runtime_state
            .unwrap()
            .turn_completed_count,
        2
    );
}

#[test]
fn stable_turn_completion_id_is_applied_once_per_terminal_epoch() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let mut completed = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    completed.turn_completion_id = Some("turn-0199aaaa-bbbb-7ac2".to_string());
    let conversation = || {
        ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::ProviderEvent,
        )
    };
    let started_at = Instant::now();

    let (first_fold, first_identity, identity_changed) = replay
        .apply_agent_state_report_with_identity_at(
            completed.clone(),
            Some(conversation()),
            started_at,
        )
        .unwrap();
    assert_eq!(first_fold, AgentStateReportFold::NoOp);
    let first = replay
        .expire_agent_runtime_state(started_at + Duration::from_secs(1))
        .unwrap()
        .expect("identified completion settles once");
    assert_eq!(first.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(first.turn_completed_count, 1);
    assert!(first_identity.is_some());
    assert!(identity_changed);
    let (duplicate_fold, duplicate_identity, duplicate_identity_changed) = replay
        .apply_agent_state_report_with_identity_at(
            completed,
            Some(conversation()),
            started_at + Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(
        duplicate_fold,
        AgentStateReportFold::NoOp,
        "provider retry or app reload must not advance the completion counter"
    );
    assert_eq!(duplicate_identity, first_identity);
    assert!(!duplicate_identity_changed);

    let current = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(current.revision, first.revision);
    assert_eq!(current.turn_completed_count, 1);

    let mut next = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    next.turn_completion_id = Some("turn-0199cccc-dddd-7b80".to_string());
    assert_eq!(
        replay
            .apply_agent_state_report_at(next, started_at + Duration::from_secs(3))
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert_eq!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(4))
            .unwrap()
            .unwrap()
            .turn_completed_count,
        2
    );
}

#[test]
fn identified_completion_waits_for_quiescence_and_a_successor_start_cancels_it() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let working = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    let started = applied(
        replay
            .apply_agent_state_report_at(working.clone(), started_at)
            .unwrap(),
    );

    let mut internal_turn_completed = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    internal_turn_completed.turn_completion_id = Some("goal-turn-1".to_string());
    let stale_retry = internal_turn_completed.clone();
    assert_eq!(
        replay
            .apply_agent_state_report_at(
                internal_turn_completed,
                started_at + Duration::from_millis(10),
            )
            .unwrap(),
        AgentStateReportFold::NoOp,
        "a completion candidate must not publish waiting before quiescence"
    );

    assert_eq!(
        replay
            .apply_agent_state_report_at(working, started_at + Duration::from_millis(20))
            .unwrap(),
        AgentStateReportFold::NoOp,
        "the automatic successor can start while the public state stays working"
    );
    assert_eq!(
        replay
            .apply_agent_state_report_at(stale_retry, started_at + Duration::from_millis(30))
            .unwrap(),
        AgentStateReportFold::NoOp,
        "a delayed retry of the superseded completion must not resurrect it"
    );
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(5))
            .unwrap()
            .is_none(),
        "the canceled internal boundary must never reappear as completion"
    );
    let still_working = replay.agent_runtime_state.as_ref().unwrap();
    assert_eq!(still_working.revision, started.revision);
    assert_eq!(still_working.activity, AgentRuntimeActivity::Working);
    assert_eq!(still_working.turn_completed_count, 0);

    let mut quiescent_completion = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    quiescent_completion.turn_completion_id = Some("goal-turn-2".to_string());
    assert_eq!(
        replay
            .apply_agent_state_report_at(quiescent_completion, started_at + Duration::from_secs(6))
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    let completed = replay
        .expire_agent_runtime_state(started_at + Duration::from_secs(7))
        .unwrap()
        .expect("a genuinely quiescent completion must publish exactly once");
    assert_eq!(completed.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(completed.turn_completed_count, 1);
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(8))
            .unwrap()
            .is_none()
    );
}

#[test]
fn provider_working_deadline_does_not_invent_task_completion() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let mut working = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    working.working_ttl_ms = Some(30_000);
    let started = applied(
        replay
            .apply_agent_state_report_at(working, started_at)
            .unwrap(),
    );

    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_millis(29_999))
            .unwrap()
            .is_none()
    );
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_millis(30_000))
            .unwrap()
            .is_none(),
        "an expired report is not evidence that provider work completed"
    );
    let retained = replay.agent_runtime_state.as_ref().unwrap();
    assert_eq!(retained.revision, started.revision);
    assert_eq!(
        retained.observed_through_output_seq, started.observed_through_output_seq,
        "expiry is independent of terminal output"
    );
    assert_eq!(retained.activity, AgentRuntimeActivity::Working);
    assert_eq!(retained.attention, AgentRuntimeAttention::None);
    assert_eq!(retained.source, AgentRuntimeStateSource::ProviderEvent);
    assert!(replay.working_deadline.is_none());
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(60))
            .unwrap()
            .is_none()
    );
}

#[test]
fn controller_working_observation_expires_at_the_host_owned_deadline() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let observed_at = Instant::now();
    let started = replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput),
            observed_at,
        )
        .unwrap()
        .expect("accepted controller submit must publish working");
    replay.ingest_output(b"provider progress").unwrap();

    let expired = replay
        .expire_agent_runtime_state(observed_at + Duration::from_secs(31))
        .unwrap()
        .expect("the Host must not retain a controller working claim forever");
    assert_eq!(expired.revision, started.revision + 1);
    assert_eq!(
        expired.observed_through_output_seq,
        replay.current_output_seq(),
        "expiry must carry the current Host output fence"
    );
    assert!(
        expired.observed_through_output_seq > started.observed_through_output_seq,
        "terminal output remains presentation but its ordering fence advances"
    );
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(expired.attention, AgentRuntimeAttention::None);
    assert_eq!(expired.source, AgentRuntimeStateSource::ControllerInput);
    assert!(
        replay
            .expire_agent_runtime_state(observed_at + Duration::from_secs(60))
            .unwrap()
            .is_none(),
        "one working claim expires only once"
    );
}

#[test]
fn repeated_controller_working_observation_refreshes_one_deadline_without_revision_churn() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeStateSource};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let started = replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput),
            started_at,
        )
        .unwrap()
        .expect("first controller submit must publish working");

    let refreshed_at = started_at + Duration::from_secs(10);
    assert!(
        replay
            .observe_agent_runtime_state_at(
                AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput),
                refreshed_at,
            )
            .unwrap()
            .is_none(),
        "an unchanged submit refreshes the claim without state churn"
    );
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(30))
            .unwrap()
            .is_none(),
        "the superseded deadline cannot expire the refreshed claim"
    );
    let expired = replay
        .expire_agent_runtime_state(refreshed_at + Duration::from_secs(30))
        .unwrap()
        .expect("the refreshed controller claim remains bounded");
    assert_eq!(expired.revision, started.revision + 1);
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(expired.source, AgentRuntimeStateSource::ControllerInput);
}

#[test]
fn refreshed_semantic_working_report_cannot_be_completed_by_either_deadline() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let mut working = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    working.working_ttl_ms = Some(30_000);
    let started = applied(
        replay
            .apply_agent_state_report_at(working, started_at)
            .unwrap(),
    );

    let refreshed_at = started_at + Duration::from_secs(10);
    let mut sticky = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    sticky.working_ttl_ms = Some(600_000);
    assert_eq!(
        replay
            .apply_agent_state_report_at(sticky, refreshed_at)
            .unwrap(),
        AgentStateReportFold::NoOp,
        "an unchanged report refreshes its deadline without state churn"
    );
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(30))
            .unwrap()
            .is_none()
    );
    assert!(
        replay
            .expire_agent_runtime_state(refreshed_at + Duration::from_secs(600))
            .unwrap()
            .is_none(),
        "neither the original nor refreshed lease proves task completion"
    );
    let retained = replay.agent_runtime_state.as_ref().unwrap();
    assert_eq!(retained.revision, started.revision);
    assert_eq!(retained.activity, AgentRuntimeActivity::Working);
    assert!(replay.working_deadline.is_none());
}

#[test]
fn newer_typed_observation_exit_and_stale_fence_win_over_working_deadline() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateSource, AgentStateReportObservationFence,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let started_at = Instant::now();
    let mut working = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    working.working_ttl_ms = Some(30_000);
    let provider = applied(
        replay
            .apply_agent_state_report_at(working, started_at)
            .unwrap(),
    );
    let stale_fence = AgentStateReportObservationFence {
        terminal_epoch: provider.terminal_epoch.clone(),
        runtime_revision: provider.revision,
        output_sequence: replay.current_output_seq(),
    };

    let controller_at = started_at + Duration::from_secs(1);
    let controller = replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput),
            controller_at,
        )
        .unwrap()
        .expect("the newer typed controller observation must apply");
    let mut stale_refresh = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    stale_refresh.working_ttl_ms = Some(1);
    stale_refresh.expected_observation = Some(stale_fence);
    assert_eq!(
        replay
            .apply_agent_state_report_at(stale_refresh, started_at + Duration::from_secs(1))
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(
        replay
            .expire_agent_runtime_state(started_at + Duration::from_secs(30))
            .unwrap()
            .is_none(),
        "the provider deadline and stale refresh cannot expire the controller claim"
    );
    let expired = replay
        .expire_agent_runtime_state(controller_at + Duration::from_secs(30))
        .unwrap()
        .expect("the newer controller claim must expire at its own deadline");
    assert_eq!(expired.revision, controller.revision + 1);
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(expired.source, AgentRuntimeStateSource::ControllerInput);

    let mut exiting = replay_with_limits(TerminalReplayLimits::default());
    let exit_started_at = Instant::now();
    exiting
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ControllerInput),
            exit_started_at,
        )
        .unwrap()
        .expect("controller working must install the deadline canceled by exit");
    let exited = exiting
        .observe_agent_runtime_state(AgentRuntimeObservation::exited())
        .unwrap()
        .expect("process exit must apply after the controller observation");
    assert_eq!(exited.lifecycle, AgentRuntimeLifecycle::Exited);
    assert!(
        exiting
            .expire_agent_runtime_state(exit_started_at + Duration::from_secs(120))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        exiting.agent_runtime_state.as_ref().unwrap().revision,
        exited.revision
    );
}

#[test]
fn provider_reports_without_attention_preserve_the_current_episode() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let blocked = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
                false,
            ))
            .unwrap(),
    );

    // An idle notification without attention detail is not a clear.
    assert_eq!(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                false,
            ))
            .unwrap(),
        AgentStateReportFold::NoOp
    );

    // Completion keeps the same episode identity while counting the turn.
    let completed = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                true,
            ))
            .unwrap(),
    );
    assert_eq!(completed.attention, AgentRuntimeAttention::ApprovalRequired);
    assert_eq!(completed.attention_id, blocked.attention_id);
    assert_eq!(completed.turn_completed_count, 1);

    // A working report legitimately ends the attention episode.
    let resumed = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                false,
            ))
            .unwrap(),
    );
    assert_eq!(resumed.attention, AgentRuntimeAttention::None);
    assert!(resumed.attention_id.is_none());
}

#[test]
fn reports_are_dropped_after_exit_and_never_change_lifecycle() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let first = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                false,
            ))
            .unwrap(),
    );
    assert_eq!(
        first.lifecycle,
        AgentRuntimeLifecycle::Running,
        "a report without prior state observes a running provider"
    );

    let exited = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::exited())
        .unwrap()
        .unwrap();
    assert_eq!(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                true,
            ))
            .unwrap(),
        AgentStateReportFold::DroppedExited
    );
    let current = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(current.lifecycle, AgentRuntimeLifecycle::Exited);
    assert_eq!(current.revision, exited.revision);
    assert_eq!(current.turn_completed_count, 0);
}

#[test]
fn inconsistent_state_reports_are_rejected_without_advancing_state() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    assert_eq!(
        replay.apply_agent_state_report(state_report(
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::InputRequired,
            false,
        )),
        Err(TerminalReplayError::InvalidAgentRuntimeState)
    );
    assert!(
        replay
            .snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_runtime_state
            .is_none()
    );
}

#[test]
fn stale_observation_fence_cannot_overwrite_a_recovered_working_state() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource,
        AgentStateReportObservationFence,
    };

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay.ingest_output(b"credential unavailable").unwrap();
    let baseline = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::InputRequired,
                false,
            ))
            .unwrap(),
    );
    let stale_boundary = AgentStateReportObservationFence {
        terminal_epoch: baseline.terminal_epoch.clone(),
        runtime_revision: baseline.revision,
        output_sequence: replay.current_output_seq(),
    };

    replay.ingest_output(b"working again").unwrap();
    let recovered = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ControllerInput,
        ))
        .unwrap()
        .unwrap();
    let mut late_error = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::Error,
        false,
    );
    late_error.expected_observation = Some(stale_boundary);
    assert_eq!(
        replay.apply_agent_state_report(late_error).unwrap(),
        AgentStateReportFold::NoOp
    );
    let current = replay
        .snapshot(ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(current.revision, recovered.revision);
    assert_eq!(current.activity, AgentRuntimeActivity::Working);
    assert_eq!(current.attention, AgentRuntimeAttention::None);

    let mut current_error = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::Error,
        false,
    );
    current_error.expected_observation = Some(AgentStateReportObservationFence {
        terminal_epoch: current.terminal_epoch,
        runtime_revision: current.revision,
        output_sequence: replay.current_output_seq(),
    });
    let applied_error = applied(replay.apply_agent_state_report(current_error).unwrap());
    assert_eq!(applied_error.attention, AgentRuntimeAttention::Error);
}

#[test]
fn combined_state_and_identity_report_rolls_back_on_late_failure() {
    use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .apply_agent_state_report(state_report(
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
            false,
        ))
        .unwrap();
    replay.agent_runtime_state.as_mut().unwrap().revision = u64::MAX;
    let mut pending_completion = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    pending_completion.turn_completion_id = Some("turn-before-failure".to_string());
    assert_eq!(
        replay.apply_agent_state_report(pending_completion).unwrap(),
        AgentStateReportFold::NoOp
    );

    assert_eq!(
        replay.apply_agent_state_report_with_identity(
            state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                false,
            ),
            Some(ProviderConversationIdentityObservation::new(
                "codex",
                "conversation-1",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
        ),
        Err(TerminalReplayError::StateRevisionExhausted)
    );
    assert!(replay.provider_conversation_identity.is_none());
    assert_eq!(
        replay.agent_runtime_state.as_ref().unwrap().activity,
        AgentRuntimeActivity::Working
    );
    assert_eq!(
        replay.agent_runtime_state.as_ref().unwrap().revision,
        u64::MAX
    );
    assert_eq!(
        replay
            .pending_turn_completion
            .as_ref()
            .and_then(|pending| pending.report.turn_completion_id.as_deref()),
        Some("turn-before-failure")
    );
    assert!(
        !replay
            .accepted_turn_completion_ids
            .contains("turn-before-failure")
    );
}

#[test]
fn retention_loss_is_an_explicit_replay_gap() {
    let limits = TerminalReplayLimits {
        max_retained_records: 2,
        ..TerminalReplayLimits::default()
    };
    let mut replay = replay_with_limits(limits);
    replay.ingest_output(b"one").unwrap();
    replay.ingest_output(b"two").unwrap();
    replay.ingest_output(b"three").unwrap();

    let cursor = ReconnectCursor {
        terminal_epoch: "terminal-1".into(),
        after_output_seq: 0,
    };
    assert!(matches!(
        replay.replay_after(&cursor).unwrap(),
        ReplayResult::Gap(ReplayGap {
            earliest_retained_output_seq: 2,
            current_output_seq: 3,
            ..
        })
    ));

    let retained_cursor = ReconnectCursor {
        after_output_seq: 1,
        ..cursor
    };
    let ReplayResult::Deltas(deltas) = replay.replay_after(&retained_cursor).unwrap() else {
        panic!("cursor at the retention boundary must replay deltas");
    };
    assert_eq!(
        deltas
            .iter()
            .map(|delta| delta.output_seq)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
}

#[test]
fn legacy_creation_colors_do_not_restore_embedder_query_replies() {
    let mut replay = TerminalReplay::new_with_default_colors(
        fence(),
        4,
        20,
        TerminalReplayLimits::default(),
        TerminalDefaultColors::new(0xe5_e5_e5, 0x24_27_3a).unwrap(),
    )
    .unwrap();

    let ingested = replay
        .ingest_output(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n")
        .unwrap();
    assert_eq!(ingested.pty_replies, b"\x1b[1;1R");
}

#[test]
fn unseeded_session_does_not_invent_default_colors() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());

    let ingested = replay
        .ingest_output(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n")
        .unwrap();
    assert_eq!(ingested.pty_replies, b"\x1b[1;1R");
}
