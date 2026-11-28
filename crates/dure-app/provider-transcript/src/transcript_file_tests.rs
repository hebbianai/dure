use super::*;
use crate::{
    ConversationTurnRole, Limits, ProviderToolState, TranscriptRoots, TranscriptWindow,
    bounded_prefix, bounded_suffix, codex_tool_events, codex_turn, codex_turn_end_cursor,
    codex_turn_start_cursor, find_codex_conversation, read_roots_activity,
    read_roots_activity_page, read_session_settings_roots, read_window,
};
use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use serde_json::json;
use std::path::PathBuf;

/// A Codex rollout compressed the way Codex compresses one: `zstd -3
/// --no-check` of a plain rollout of 225,516 bytes, one frame that records
/// its content size. Eight turns, each a prompt, a command and a long answer.
const COMPRESSED_ROLLOUT: &[u8] = include_bytes!("../fixtures/codex-rollout.jsonl.zst");
const ROLLOUT_ID: &str = "019f0000-0000-7000-8000-000000000820";
const ROLLOUT_LEN: u64 = 225_516;
/// Where each turn of that rollout starts: its `task_started` event.
const TURN_STARTS: [u64; 8] = [
    191, 28_361, 56_518, 84_684, 112_850, 141_011, 169_181, 197_349,
];

fn rollout_name(id: &str, encoding: &str) -> String {
    format!("rollout-2026-10-12T00-00-00-{id}.jsonl{encoding}")
}

/// Writes `bytes` as a rollout named `name` in a Codex home's sessions.
fn write_rollout(home: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let day = home.join("sessions/2026/10/12");
    fs::create_dir_all(&day).unwrap();
    let path = day.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

/// A plain Codex rollout of `turns` turns. Its answers grow, from the fifth
/// turn on past one decode step, so reads cross steps.
fn generated_rollout(id: &str, turns: usize) -> Vec<u8> {
    let mut source = format!("{}\n", json!({"type":"session_meta","payload":{"id":id}}));
    for index in 0..turns {
        let turn = format!("turn-{index}");
        let answer = format!(
            "answer {index} {}",
            "lorem ipsum ".repeat(index * 5_000 + 10)
        );
        for record in [
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}),
            json!({"type":"turn_context","payload":{"turn_id":turn,"model":"model-a","effort":"low"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":format!("prompt {index}")}]}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":turn,
                "item":{"type":"CommandExecution","id":format!("call-{index}"),
                    "command":"true","status":"completed"}}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":answer}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn}}),
        ] {
            source.push_str(&format!("{record}\n"));
        }
    }
    source.into_bytes()
}

/// The same rollout in two Codex homes: plain in one, compressed in the other.
struct Pair {
    _homes: [tempfile::TempDir; 2],
    plain: PathBuf,
    compressed: PathBuf,
}

impl Pair {
    fn new(id: &str, records: &[u8], compressed: Vec<u8>) -> Self {
        let homes = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        Self {
            plain: write_rollout(homes[0].path(), &rollout_name(id, ""), records),
            compressed: write_rollout(homes[1].path(), &rollout_name(id, ".zst"), &compressed),
            _homes: homes,
        }
    }

    fn sessions(path: &Path) -> &Path {
        path.ancestors().nth(4).unwrap()
    }
}

fn page(path: &Path, id: &str, before: Option<u64>) -> TranscriptWindow {
    let limits = Limits {
        source: 400_000,
        output: 300_000,
        entries: 5,
        ..Limits::DEFAULT
    };
    read_window(
        path,
        "codex",
        id,
        codex_turn,
        Some(codex_tool_events),
        limits,
        before,
        0,
    )
    .unwrap()
}

/// Every page of a transcript from its newest back to its start: each
/// page's messages, calls and older cursor.
fn pages(path: &Path, id: &str) -> Vec<(Vec<String>, Vec<String>, Option<u64>)> {
    let mut pages = Vec::new();
    let mut before = None;
    loop {
        let window = page(path, id, before);
        pages.push((
            window
                .transcript
                .entries
                .iter()
                .map(|entry| entry.text.chars().take(20).collect())
                .collect(),
            window
                .tools
                .iter()
                .map(|call| call.call_id.clone())
                .collect(),
            window.older_cursor,
        ));
        match window.older_cursor {
            Some(cursor) => before = Some(cursor),
            None => return pages,
        }
    }
}

/// A rollout Codex compressed reads as its conversation: every message and
/// command, the settings of its last turn, and turn cursors that page it.
#[test]
fn a_compressed_codex_rollout_reads_as_its_conversation() {
    let home = tempfile::tempdir().unwrap();
    let path = write_rollout(
        home.path(),
        &rollout_name(ROLLOUT_ID, ".zst"),
        COMPRESSED_ROLLOUT,
    );
    let roots = TranscriptRoots::in_state_directory(home.path());

    assert_eq!(
        TranscriptFile::open(&path).unwrap().len().unwrap(),
        ROLLOUT_LEN
    );
    let activity = read_roots_activity(&roots, "codex", ROLLOUT_ID).unwrap();
    let expected = (0..8)
        .flat_map(|turn| {
            [
                (ConversationTurnRole::User, format!("prompt {turn}")),
                (ConversationTurnRole::Agent, format!("answer {turn}")),
            ]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        activity
            .transcript
            .entries
            .iter()
            .map(|entry| (
                entry.role,
                entry.text.split(':').next().unwrap().to_string()
            ))
            .collect::<Vec<_>>(),
        expected
    );
    assert!(activity.transcript.history_complete);
    assert_eq!(activity.older_cursor, None);
    assert_eq!(
        activity.transcript.final_response.as_deref(),
        Some("answer 7")
    );
    assert_eq!(
        activity
            .tools
            .iter()
            .map(|call| (call.call_id.clone(), call.state))
            .collect::<Vec<_>>(),
        (0..8)
            .map(|turn| (format!("call-{turn}"), ProviderToolState::Completed))
            .collect::<Vec<_>>()
    );

    let sessions = &roots.codex_sessions;
    for (turn, start) in TURN_STARTS.iter().enumerate() {
        assert_eq!(
            codex_turn_start_cursor(sessions, ROLLOUT_ID, &format!("turn-{turn}")),
            Ok(Some(*start)),
            "turn {turn}"
        );
    }
    assert_eq!(
        codex_turn_end_cursor(sessions, ROLLOUT_ID, "turn-2", TURN_STARTS[5]),
        Ok(Some(TURN_STARTS[3]))
    );
    assert!(codex_turn_end_cursor(sessions, ROLLOUT_ID, "turn-2", ROLLOUT_LEN + 1).is_err());
    let older = read_roots_activity_page(&roots, "codex", ROLLOUT_ID, TURN_STARTS[2], 0).unwrap();
    assert_eq!(
        older
            .transcript
            .entries
            .iter()
            .map(|entry| entry.text.split(':').next().unwrap())
            .collect::<Vec<_>>(),
        ["prompt 0", "answer 0", "prompt 1", "answer 1"]
    );
    let stale = read_roots_activity_page(&roots, "codex", ROLLOUT_ID, ROLLOUT_LEN + 1, 0);
    assert!(stale.unwrap_err().contains("changed"));

    let settings = read_session_settings_roots(&roots, "codex", ROLLOUT_ID).unwrap();
    assert_eq!(settings.model.as_deref(), Some("model-a"));
    assert_eq!(settings.effort.as_deref(), Some("high"));
}

/// Read in pages, by its turns or by its ends, a compressed copy holds what
/// its plain file holds at the same offsets.
#[test]
fn a_compressed_copy_reads_exactly_as_its_plain_file() {
    let id = "019f0000-0000-7000-8000-000000000821";
    let records = generated_rollout(id, 7);
    let pair = Pair::new(
        id,
        &records,
        compress_to_vec(&records[..], CompressionLevel::Fastest),
    );

    let plain_pages = pages(&pair.plain, id);
    assert!(plain_pages.len() > 3, "the rollout spans several pages");
    assert_eq!(pages(&pair.compressed, id), plain_pages);
    for max_bytes in [1, 4096, 300_000, u64::MAX] {
        assert_eq!(
            bounded_suffix(&pair.compressed, max_bytes),
            bounded_suffix(&pair.plain, max_bytes),
            "suffix of {max_bytes}"
        );
        assert_eq!(
            bounded_prefix(&pair.compressed, max_bytes),
            bounded_prefix(&pair.plain, max_bytes),
            "prefix of {max_bytes}"
        );
    }
    assert_eq!(
        bounded_windows(&pair.compressed, 4096),
        bounded_windows(&pair.plain, 4096)
    );
    for turn in 0..7 {
        let turn = format!("turn-{turn}");
        let start = codex_turn_start_cursor(Pair::sessions(&pair.plain), id, &turn);
        assert!(matches!(start, Ok(Some(_))), "{turn}");
        assert_eq!(
            codex_turn_start_cursor(Pair::sessions(&pair.compressed), id, &turn),
            start
        );
        assert_eq!(
            codex_turn_end_cursor(
                Pair::sessions(&pair.compressed),
                id,
                &turn,
                records.len() as u64
            ),
            codex_turn_end_cursor(Pair::sessions(&pair.plain), id, &turn, records.len() as u64)
        );
    }
}

/// A walk reads the plain file while it is beside its compressed copy, as
/// Codex does, and the copy once the plain file is gone.
#[test]
fn a_walk_reads_the_plain_file_while_both_are_there() {
    let home = tempfile::tempdir().unwrap();
    let plain = write_rollout(home.path(), &rollout_name(ROLLOUT_ID, ""), b"");
    let compressed = write_rollout(
        home.path(),
        &rollout_name(ROLLOUT_ID, ".zst"),
        COMPRESSED_ROLLOUT,
    );
    let plain_name = rollout_name(ROLLOUT_ID, "");
    assert_eq!(transcript_name(&plain), Some(plain_name.as_str()));
    assert_eq!(transcript_name(&compressed), None);
    for other in [
        "state.sqlite",
        "rollout.zst",
        "rollout.jsonl.gz",
        "rollout.json",
    ] {
        assert_eq!(transcript_name(&home.path().join(other)), None, "{other}");
    }
    let sessions = home.path().join("sessions");
    // The empty plain file names no conversation, and hides the copy.
    assert_eq!(
        find_codex_conversation(&sessions, ROLLOUT_ID, 0, &mut 0),
        None
    );

    fs::remove_file(&plain).unwrap();
    assert_eq!(transcript_name(&compressed), Some(plain_name.as_str()));
    assert_eq!(
        find_codex_conversation(&sessions, ROLLOUT_ID, 0, &mut 0).map(|(_, path)| path),
        Some(compressed)
    );
}

/// A stream of several frames, with a skippable frame between them, holds
/// the records of each frame in turn.
#[test]
fn frames_and_skippable_frames_decode_in_order() {
    let id = "019f0000-0000-7000-8000-000000000822";
    let records = generated_rollout(id, 4);
    let split = records
        .iter()
        .take(records.len() / 2)
        .rposition(|byte| *byte == b'\n')
        .unwrap()
        + 1;
    let mut stream = compress_to_vec(&records[..split], CompressionLevel::Fastest);
    stream.extend(0x184D_2A50_u32.to_le_bytes());
    stream.extend(3_u32.to_le_bytes());
    stream.extend(b"pad");
    stream.extend(compress_to_vec(
        &records[split..],
        CompressionLevel::Uncompressed,
    ));
    let pair = Pair::new(id, &records, stream);

    assert_eq!(
        bounded_prefix(&pair.compressed, u64::MAX).map(String::into_bytes),
        Some(records.clone())
    );
    assert_eq!(pages(&pair.compressed, id), pages(&pair.plain, id));
}

/// A walk's windows of a compressed transcript decode it only as far as
/// their bound: past it, the transcript has its prefix and no suffix. A plain
/// one always has both, since it reads only them.
#[test]
fn windows_stop_decoding_a_compressed_transcript_at_their_bound() {
    let id = "019f0000-0000-7000-8000-000000000823";
    let records = generated_rollout(id, 6);
    let pair = Pair::new(
        id,
        &records,
        compress_to_vec(&records[..], CompressionLevel::Fastest),
    );
    let bound = records.len() as u64 / 2;

    let bounded = windows_within(&pair.compressed, 4096, bound).unwrap();
    assert_eq!(bounded.prefix.as_bytes(), &records[..4096]);
    assert_eq!(bounded.suffix, None);
    assert!(!bounded.whole);
    let plain = windows_within(&pair.plain, 4096, bound).unwrap();
    assert_eq!(plain.prefix, bounded.prefix);
    assert!(plain.suffix.is_some());
    assert_eq!(
        windows_within(&pair.compressed, 4096, records.len() as u64),
        Some(plain.clone())
    );

    let whole = windows_within(&pair.compressed, records.len() as u64, u64::MAX).unwrap();
    assert!(whole.whole);
    assert_eq!(whole.suffix.as_deref(), Some(whole.prefix.as_str()));
}

/// A compressed copy cut short, or one that is not zstd at all, never reads
/// as records past where its stream breaks: reads that reach the break fail.
#[test]
fn a_damaged_compressed_copy_is_unreadable() {
    let cut = &COMPRESSED_ROLLOUT[..COMPRESSED_ROLLOUT.len() / 2];
    for (name, bytes) in [
        ("cut", cut),
        ("not zstd", &b"{\"type\":\"session_meta\"}\n"[..]),
    ] {
        let home = tempfile::tempdir().unwrap();
        let path = write_rollout(home.path(), &rollout_name(ROLLOUT_ID, ".zst"), bytes);
        assert_eq!(bounded_prefix(&path, u64::MAX), None, "{name}");
        assert_eq!(bounded_suffix(&path, 4096), None, "{name}");
        assert!(
            bounded_windows(&path, 4096).is_none_or(|windows| windows.suffix.is_none()),
            "{name}"
        );
        assert!(
            crate::activity_from_file(&path, "codex", ROLLOUT_ID).is_err(),
            "{name}"
        );
    }
}
