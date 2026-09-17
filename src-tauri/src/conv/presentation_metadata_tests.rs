use super::*;
use std::io::{self, Cursor, Write};

struct CountedReader {
    data: Cursor<Vec<u8>>,
    bytes: usize,
}

impl CountedReader {
    fn new(data: Vec<u8>) -> Self {
        Self {
            data: Cursor::new(data),
            bytes: 0,
        }
    }

    fn read_metadata(&mut self, provider: &str, id: &str) -> Option<Metadata> {
        let size = self.data.get_ref().len() as u64;
        read_activity(self, size, provider, id)
    }
}

impl Read for CountedReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = self.data.read(buffer)?;
        self.bytes += length;
        Ok(length)
    }
}

impl Seek for CountedReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.data.seek(position)
    }
}

fn prompt(provider: &str, text: &str) -> String {
    let value = if provider == "codex" {
        serde_json::json!({"type":"event_msg", "timestamp":"2026-09-13T00:00:00Z",
            "payload":{"type":"user_message", "message":text}})
    } else {
        serde_json::json!({"type":"user", "timestamp":"2026-09-13T00:00:00Z",
            "message":{"content":text}})
    };
    format!("{value}\n")
}

#[test]
fn recent_prompts_stop_io_before_old_tool_output() {
    for provider in ["codex", "claude"] {
        let mut bytes = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n".to_vec();
        bytes.resize(10 * 1024 * 1024, b'x');
        bytes.push(b'\n');
        for index in 0..10 {
            bytes.extend(prompt(provider, &format!("prompt {index}")).as_bytes());
        }
        let mut reader = CountedReader::new(bytes);
        let metadata = reader.read_metadata(provider, "thread").unwrap();
        assert_eq!(
            metadata.recent_prompts,
            (2..10).map(|i| format!("prompt {i}")).collect::<Vec<_>>()
        );
        assert_eq!(
            metadata.activity_at.as_deref(),
            Some("2026-09-13T00:00:00Z")
        );
        assert!(
            reader.bytes <= READ_CHUNK_BYTES + 4096,
            "read {} bytes",
            reader.bytes
        );
    }
}

#[test]
fn split_utf8_and_json_lines_keep_the_same_prompt_and_activity() {
    for provider in ["codex", "claude"] {
        // Move every byte of a short Unicode record across a chunk boundary.
        let message = prompt(provider, "한글🙂 café").replace('\n', "\r\n");
        for offset in 0..message.len() + 2 {
            let mut bytes =
                b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n".to_vec();
            bytes.extend(message.as_bytes());
            bytes.extend(std::iter::repeat_n(b' ', READ_CHUNK_BYTES - offset));
            bytes.extend(b"\n{broken");
            let mut reader = CountedReader::new(bytes);
            let metadata = reader.read_metadata(provider, "thread").unwrap();
            assert_eq!(
                metadata.recent_prompts,
                vec!["한글🙂 café"],
                "offset {offset}"
            );
            assert_eq!(
                metadata.activity_at.as_deref(),
                Some("2026-09-13T00:00:00Z")
            );
        }
    }
}

#[test]
fn oversized_and_cut_records_never_expand_the_prompt_window() {
    let mut bytes = prompt("claude", "outside the window").into_bytes();
    bytes.extend(std::iter::repeat_n(b'x', PROMPT_WINDOW_BYTES as usize));
    bytes.push(b'\n');
    bytes.extend(prompt("claude", "retained").as_bytes());
    let mut reader = CountedReader::new(bytes);
    assert_eq!(
        reader
            .read_metadata("claude", "thread")
            .unwrap()
            .recent_prompts,
        vec!["retained"]
    );
    assert_eq!(reader.bytes, PROMPT_WINDOW_BYTES as usize);

    let mut bytes = vec![b'x'; 10];
    bytes.extend(prompt("claude", "cut first row").as_bytes());
    bytes.resize(PROMPT_WINDOW_BYTES as usize + 10, b' ');
    let mut reader = CountedReader::new(bytes);
    assert!(reader
        .read_metadata("claude", "thread")
        .unwrap()
        .recent_prompts
        .is_empty());
}

#[test]
fn codex_identity_is_checked_before_reading_the_tail() {
    let mut bytes = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"other\"}}\n".to_vec();
    bytes.resize(10 * 1024 * 1024, b' ');
    bytes.extend(prompt("codex", "not this conversation").as_bytes());
    let mut reader = CountedReader::new(bytes);
    assert!(reader.read_metadata("codex", "thread").is_none());
    assert!(reader.bytes <= 4096);
}

#[test]
fn appended_partial_records_and_rewrites_refresh_the_cached_result() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("thread.jsonl");
    fs::write(&path, prompt("claude", "before")).unwrap();
    assert_eq!(
        file_activity("claude", "thread", &path)
            .unwrap()
            .recent_prompts,
        vec!["before"]
    );
    let next = prompt("claude", "completed later");
    let split = next.len() / 2;
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&next.as_bytes()[..split]).unwrap();
    assert_eq!(
        file_activity("claude", "thread", &path)
            .unwrap()
            .recent_prompts,
        vec!["before"]
    );
    // A complete JSON record without a final newline is still observed.
    file.write_all(&next.as_bytes()[split..next.len() - 1])
        .unwrap();
    assert_eq!(
        file_activity("claude", "thread", &path)
            .unwrap()
            .recent_prompts,
        vec!["before", "completed later"]
    );
    fs::write(&path, prompt("claude", "replacement")).unwrap();
    assert_eq!(
        file_activity("claude", "thread", &path)
            .unwrap()
            .recent_prompts,
        vec!["replacement"]
    );
}

fn target(root: &Path, provider: &str, id: &str) -> Option<MetadataTarget> {
    Some(MetadataTarget {
        provider: provider.into(),
        conversation_id: id.into(),
        cwd: "/repo".into(),
        root: root.to_path_buf(),
    })
}

async fn codex_fixture(root: &Path, label: &str) -> PathBuf {
    fs::create_dir_all(root.join("sessions")).unwrap();
    let path = root.join("sessions/thread.jsonl");
    fs::write(
        &path,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"thread\"}}}}\n{}",
            prompt("codex", label)
        ),
    )
    .unwrap();
    let options = SqliteConnectOptions::new()
        .filename(root.join("state_5.sqlite"))
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO threads VALUES (?, ?)")
        .bind("thread")
        .bind(path.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    fs::write(
        root.join("session_index.jsonl"),
        format!("{{\"id\":\"thread\",\"thread_name\":\"{label}\"}}\n"),
    )
    .unwrap();
    path
}

#[tokio::test]
async fn batch_keeps_position_duplicates_profile_isolation_and_unknown_targets() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    codex_fixture(&first, "first profile").await;
    codex_fixture(&second, "second profile").await;
    let claude = directory.path().join("claude");
    let project = claude.join("projects").join(encode_cwd("/repo"));
    fs::create_dir_all(&project).unwrap();
    fs::write(
        project.join("thread.jsonl"),
        prompt("claude", "claude profile"),
    )
    .unwrap();
    let results = read_batch(
        vec![
            target(&second, "codex", "thread"),
            None,
            target(&first, "codex", "thread"),
            target(&second, "codex", "thread"),
            target(&first, "codex", "../thread"),
            target(&first, "other", "thread"),
            target(&first, "codex", "missing"),
            target(&claude, "claude", "thread"),
        ],
        None,
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 8);
    assert_eq!(
        results[0].as_ref().unwrap().recent_prompts,
        vec!["second profile"]
    );
    assert_eq!(
        results[2].as_ref().unwrap().recent_prompts,
        vec!["first profile"]
    );
    assert_eq!(
        results[2].as_ref().unwrap().title.as_deref(),
        Some("first profile")
    );
    assert_eq!(results[3], results[0]);
    for index in [1, 4, 5] {
        assert!(results[index].is_none());
    }
    assert_eq!(results[6], Some(Metadata::default()));
    assert_eq!(
        results[7].as_ref().unwrap().recent_prompts,
        vec!["claude profile"]
    );
}

#[tokio::test]
async fn shared_sqlite_index_cannot_authorize_another_profiles_rollout() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    codex_fixture(&first, "first profile").await;
    let second_path = codex_fixture(&second, "second profile").await;
    let results = read_batch(
        vec![
            target(&first, "codex", "thread"),
            target(&second, "codex", "thread"),
        ],
        Some(first.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        results[0].as_ref().unwrap().recent_prompts,
        vec!["first profile"]
    );
    assert!(results[1].as_ref().unwrap().recent_prompts.is_empty());
    assert_eq!(
        results[1].as_ref().unwrap().title.as_deref(),
        Some("second profile")
    );

    // A fresh poll must re-read a changed index, without retaining rollout paths.
    let options = SqliteConnectOptions::new().filename(first.join("state_5.sqlite"));
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("UPDATE threads SET rollout_path = ? WHERE id = 'thread'")
        .bind(second_path.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let results = read_batch(
        vec![
            target(&first, "codex", "thread"),
            target(&second, "codex", "thread"),
        ],
        Some(first),
    )
    .await
    .unwrap();
    assert!(results[0].as_ref().unwrap().recent_prompts.is_empty());
    assert_eq!(
        results[1].as_ref().unwrap().recent_prompts,
        vec!["second profile"]
    );
}

#[tokio::test]
async fn absent_database_does_not_drop_titles_or_other_profiles() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing");
    let present = directory.path().join("present");
    codex_fixture(&missing, "kept title").await;
    codex_fixture(&present, "working profile").await;
    fs::remove_file(missing.join("state_5.sqlite")).unwrap();
    let results = read_batch(
        vec![
            target(&missing, "codex", "thread"),
            target(&present, "codex", "thread"),
        ],
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        results[0].as_ref().unwrap().title.as_deref(),
        Some("kept title")
    );
    assert!(results[0].as_ref().unwrap().recent_prompts.is_empty());
    assert_eq!(
        results[1].as_ref().unwrap().recent_prompts,
        vec!["working profile"]
    );
    assert!(read_batch(Vec::new(), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn malformed_index_row_does_not_discard_valid_siblings() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let path = codex_fixture(root, "valid row").await;
    let options = SqliteConnectOptions::new().filename(root.join("state_5.sqlite"));
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("DROP TABLE threads")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO threads VALUES ('thread', ?), ('malformed', NULL)")
        .bind(path.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let results = read_batch(
        vec![
            target(root, "codex", "malformed"),
            target(root, "codex", "thread"),
        ],
        None,
    )
    .await
    .unwrap();
    assert_eq!(results[0], Some(Metadata::default()));
    assert_eq!(
        results[1].as_ref().unwrap().recent_prompts,
        vec!["valid row"]
    );
}
