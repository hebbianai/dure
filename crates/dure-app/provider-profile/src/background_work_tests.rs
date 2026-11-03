use super::*;
use serde_json::json;
use std::fs;
use tempfile::TempDir;

const T0: u64 = 1_793_600_000_000; // 2026-11-02T06:13:20Z

fn iso(ms: u64) -> String {
    // Days-from-civil inverse, enough for fixtures.
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

struct Session {
    _dir: TempDir,
    file: PathBuf,
    lines: Vec<String>,
}

impl Session {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("conv-1.jsonl");
        Self {
            _dir: dir,
            file,
            lines: Vec::new(),
        }
    }
    fn side(&self) -> PathBuf {
        self.file.with_extension("")
    }
    fn push(&mut self, value: serde_json::Value) -> &mut Self {
        self.lines.push(value.to_string());
        self
    }
    fn tool_use(&mut self, at: u64, id: &str, name: &str, input: serde_json::Value) -> &mut Self {
        self.push(json!({"type":"assistant","timestamp":iso(at),"message":{"id":format!("m-{id}"),"role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}))
    }
    fn tool_result(&mut self, at: u64, id: &str, result: serde_json::Value) -> &mut Self {
        self.push(json!({"type":"user","timestamp":iso(at),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},"toolUseResult":result}))
    }
    fn notification(
        &mut self,
        at: u64,
        task_id: &str,
        tool_use_id: &str,
        status: &str,
    ) -> &mut Self {
        let content = format!(
            "<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>{tool_use_id}</tool-use-id>\n<status>{status}</status>\n</task-notification>"
        );
        self.push(json!({"type":"queue-operation","operation":"enqueue","timestamp":iso(at),"content":content}))
    }
    fn write(&self) {
        fs::write(&self.file, self.lines.join("\n") + "\n").unwrap();
    }
    fn write_side(&self, relative: &str, content: &str) {
        let path = self.side().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn read(&self, since: Option<u64>, now: u64) -> BackgroundWorkList {
        self.write();
        read_claude_background_work_at(&self.file, since, now, &Limits::default())
    }
}

fn shell(session: &mut Session, at: u64, id: &str, task: &str, description: &str) {
    session
        .tool_use(
            at,
            id,
            "Bash",
            json!({"command":"sleep 100","description":description,"run_in_background":true}),
        )
        .tool_result(
            at + 10,
            id,
            json!({"backgroundTaskId":task,"stdout":"","stderr":"","interrupted":false}),
        );
}

#[test]
fn a_background_shell_runs_until_its_notification() {
    let mut s = Session::new();
    shell(&mut s, T0, "tu-1", "b1", "Watch the release chain");
    let running = s.read(None, T0 + 60_000);
    assert_eq!(
        running.counts,
        BackgroundWorkCounts {
            shells: 1,
            ..Default::default()
        }
    );
    assert_eq!(running.items.len(), 1);
    let item = &running.items[0];
    assert_eq!(item.kind, BackgroundWorkKind::Shell);
    assert_eq!(item.id, "b1");
    assert_eq!(item.label.as_deref(), Some("Watch the release chain"));
    assert_eq!(item.started_unix_ms, T0);
    assert_eq!(item.steps, None);
    assert_eq!(item.tokens, None);

    s.notification(T0 + 90_000, "b1", "tu-1", "completed");
    assert!(s.read(None, T0 + 100_000).items.is_empty());
}

#[test]
fn a_foreground_command_is_not_background_work() {
    let mut s = Session::new();
    s.tool_use(
        T0,
        "tu-1",
        "Bash",
        json!({"command":"ls","description":"List files"}),
    );
    assert!(s.read(None, T0 + 1_000).items.is_empty());
}

#[test]
fn a_monitor_ends_at_its_timeout_unless_persistent() {
    let mut s = Session::new();
    s.tool_use(
        T0,
        "tu-m",
        "Monitor",
        json!({"command":"tail -f x","description":"CI result","timeout_ms":600_000}),
    )
    .tool_result(
        T0 + 5,
        "tu-m",
        json!({"taskId":"m1","timeoutMs":600_000,"persistent":false}),
    )
    .tool_use(
        T0,
        "tu-p",
        "Monitor",
        json!({"command":"tail -f y","description":"Release log","persistent":true}),
    )
    .tool_result(
        T0 + 5,
        "tu-p",
        json!({"taskId":"m2","timeoutMs":600_000,"persistent":true}),
    );
    let before = s.read(None, T0 + 599_000);
    assert_eq!(before.counts.monitors, 2);
    let after = s.read(None, T0 + 601_000);
    assert_eq!(after.counts.monitors, 1);
    assert_eq!(after.items[0].id, "m2");
    assert_eq!(after.items[0].kind, BackgroundWorkKind::Monitor);
}

#[test]
fn an_async_subagent_reports_tokens_and_ends_when_meta_says_finished() {
    let mut s = Session::new();
    s.tool_use(
        T0,
        "tu-a",
        "Agent",
        json!({"description":"Review the diff","prompt":"secret prompt","run_in_background":true}),
    )
    .tool_result(
        T0 + 5,
        "tu-a",
        json!({"isAsync":true,"status":"async_launched","agentId":"a1"}),
    );
    // The same message is recorded once per content block; its usage counts once.
    let agent = [
        json!({"type":"assistant","message":{"id":"x1","usage":{"output_tokens":1200}}}),
        json!({"type":"assistant","message":{"id":"x1","usage":{"output_tokens":1200}}}),
        json!({"type":"assistant","message":{"id":"x2","usage":{"output_tokens":300}}}),
        json!({"type":"user","message":{"content":"tool output"}}),
    ]
    .iter()
    .map(|v| v.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    s.write_side("subagents/agent-a1.jsonl", &agent);
    s.write_side(
        "subagents/agent-a1.meta.json",
        r#"{"description":"Review the diff","toolUseId":"tu-a"}"#,
    );
    let running = s.read(None, T0 + 60_000);
    assert_eq!(running.counts.subagents, 1);
    let item = &running.items[0];
    assert_eq!(
        (item.kind, item.id.as_str()),
        (BackgroundWorkKind::Subagent, "a1")
    );
    assert_eq!(item.tokens, Some(1500));
    assert_eq!(item.label.as_deref(), Some("Review the diff"));

    s.write_side(
        "subagents/agent-a1.meta.json",
        r#"{"description":"Review the diff","toolUseId":"tu-a","finished":true}"#,
    );
    assert!(s.read(None, T0 + 61_000).items.is_empty());
}

#[test]
fn a_foreground_subagent_runs_until_its_result() {
    let mut s = Session::new();
    s.tool_use(
        T0,
        "tu-f",
        "Agent",
        json!({"description":"Map the code","prompt":"p"}),
    );
    let running = s.read(None, T0 + 1_000);
    assert_eq!(running.counts.subagents, 1);
    assert_eq!(running.items[0].id, "tu-f");
    s.tool_result(
        T0 + 2_000,
        "tu-f",
        json!({"status":"completed","agentId":"a9"}),
    );
    assert!(s.read(None, T0 + 3_000).items.is_empty());
}

#[test]
fn a_workflow_counts_journal_steps_and_ends_when_its_record_exists() {
    let mut s = Session::new();
    s.tool_use(T0, "tu-w", "Workflow", json!({"script":"export const meta = {}"}))
        .tool_result(T0 + 5, "tu-w", json!({"status":"async_launched","taskId":"w1","runId":"wf_abc-123","workflowName":"typing-accuracy-first"}));
    let journal = [
        json!({"type":"launched"}),
        json!({"type":"started","agentId":"g1"}),
        json!({"type":"started","agentId":"g2"}),
        json!({"type":"started","agentId":"g3"}),
        json!({"type":"result","agentId":"g1"}),
        json!({"type":"failed","agentId":"g2"}),
    ]
    .iter()
    .map(|v| v.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    s.write_side("subagents/workflows/wf_abc-123/journal.jsonl", &journal);
    s.write_side(
        "subagents/workflows/wf_abc-123/agent-g1.jsonl",
        &json!({"type":"assistant","message":{"id":"y1","usage":{"output_tokens":700}}})
            .to_string(),
    );
    s.write_side(
        "subagents/workflows/wf_abc-123/agent-g3.jsonl",
        &json!({"type":"assistant","message":{"id":"y2","usage":{"output_tokens":50}}}).to_string(),
    );
    let running = s.read(None, T0 + 60_000);
    assert_eq!(running.counts.workflows, 1);
    let item = &running.items[0];
    assert_eq!(
        (item.kind, item.id.as_str()),
        (BackgroundWorkKind::Workflow, "wf_abc-123")
    );
    assert_eq!(item.label.as_deref(), Some("typing-accuracy-first"));
    assert_eq!(item.steps, Some(BackgroundWorkSteps { done: 2, total: 3 }));
    assert_eq!(item.tokens, Some(750));

    s.write_side("workflows/wf_abc-123.json", r#"{"status":"completed"}"#);
    assert!(s.read(None, T0 + 61_000).items.is_empty());
}

#[test]
fn a_workflow_notification_by_task_id_ends_it() {
    let mut s = Session::new();
    s.tool_use(T0, "tu-w", "Workflow", json!({"script":"x"}))
        .tool_result(T0 + 5, "tu-w", json!({"status":"async_launched","taskId":"w1","runId":"wf_abc-123","workflowName":"x"}))
        .push(json!({"type":"user","timestamp":iso(T0 + 9_000),"message":{"role":"user","content":"<task-notification>\n<task-id>w1</task-id>\n<status>killed</status>\n</task-notification>"}}));
    assert!(s.read(None, T0 + 10_000).items.is_empty());
}

#[test]
fn task_stop_ends_an_item() {
    let mut s = Session::new();
    shell(&mut s, T0, "tu-1", "b1", "Long build");
    s.tool_use(T0 + 5_000, "tu-stop", "TaskStop", json!({"task_id":"b1"}));
    assert!(s.read(None, T0 + 6_000).items.is_empty());
}

#[test]
fn items_started_before_since_are_dropped() {
    let mut s = Session::new();
    shell(&mut s, T0, "tu-old", "b-old", "From the crashed process");
    shell(&mut s, T0 + 50_000, "tu-new", "b-new", "From this process");
    let list = s.read(Some(T0 + 10_000), T0 + 60_000);
    assert_eq!(list.counts.shells, 1);
    assert_eq!(list.items[0].id, "b-new");
}

#[test]
fn an_item_without_the_expected_fields_is_left_out() {
    let mut s = Session::new();
    // No toolUseResult with a task id: the format moved; never show it as running.
    s.tool_use(T0, "tu-1", "Bash", json!({"command":"sleep 1","description":"x","run_in_background":true}))
        .push(json!({"type":"user","timestamp":iso(T0 + 5),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-1","content":"ok"}]}}))
        // An unparseable timestamp leaves its item out too.
        .push(json!({"type":"assistant","timestamp":"yesterday","message":{"id":"m","content":[{"type":"tool_use","id":"tu-2","name":"Agent","input":{"description":"d"}}]}}));
    let list = s.read(None, T0 + 1_000);
    assert!(list.items.is_empty(), "{list:?}");
    assert_eq!(list.counts, BackgroundWorkCounts::default());
}

#[test]
fn a_truncated_last_line_and_a_large_file_stay_bounded() {
    let mut s = Session::new();
    shell(&mut s, T0, "tu-early", "b-early", "Outside the window");
    for i in 0..200 {
        s.push(json!({"type":"assistant","timestamp":iso(T0 + 100 + i),"message":{"id":format!("f{i}"),"content":[{"type":"text","text":"padding ".repeat(20)}]}}));
    }
    shell(&mut s, T0 + 1_000, "tu-late", "b-late", "Inside the window");
    s.write();
    // A record cut mid-write at the end.
    let mut bytes = fs::read(&s.file).unwrap();
    bytes.extend_from_slice(br#"{"type":"assistant","timestamp":"2026-11-02T08:53:"#);
    fs::write(&s.file, bytes).unwrap();
    let limits = Limits {
        main_bytes: 8 * 1024,
        ..Limits::default()
    };
    let list = read_claude_background_work_at(&s.file, None, T0 + 2_000, &limits);
    assert_eq!(
        list.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["b-late"]
    );
}

#[test]
fn labels_never_include_the_command() {
    let mut s = Session::new();
    s.tool_use(T0, "tu-1", "Bash", json!({"command":"curl -H 'Authorization: Bearer SECRET' https://x","run_in_background":true}))
        .tool_result(T0 + 5, "tu-1", json!({"backgroundTaskId":"b1"}));
    shell(&mut s, T0 + 10, "tu-2", "b2", "Fetch\u{7} status\n");
    let list = s.read(None, T0 + 1_000);
    assert_eq!(list.items.len(), 2);
    let text = serde_json::to_string(&list).unwrap();
    assert!(!text.contains("SECRET"), "{text}");
    assert!(!text.contains("curl"), "{text}");
    let by_id = |id: &str| {
        list.items
            .iter()
            .find(|i| i.id == id)
            .unwrap()
            .label
            .clone()
    };
    assert_eq!(by_id("b1"), None);
    assert_eq!(by_id("b2").as_deref(), Some("Fetch status"));
}

#[test]
fn a_long_label_is_cut_on_a_character_boundary() {
    let mut s = Session::new();
    shell(&mut s, T0, "tu-1", "b1", &"가".repeat(200));
    let label = s.read(None, T0 + 1_000).items[0].label.clone().unwrap();
    assert_eq!(label.chars().count(), MAX_BACKGROUND_WORK_LABEL_CHARS);
}

#[test]
fn more_than_64_items_keep_exact_counts_and_set_truncated() {
    let mut s = Session::new();
    for i in 0..70u64 {
        shell(
            &mut s,
            T0 + i * 100,
            &format!("tu-{i}"),
            &format!("b{i}"),
            "work",
        );
    }
    let list = s.read(None, T0 + 100_000);
    assert_eq!(list.counts.shells, 70);
    assert_eq!(list.items.len(), MAX_BACKGROUND_WORK_ITEMS);
    assert!(list.truncated);
    assert_eq!(list.items[0].id, "b69", "newest first");
}

#[test]
fn a_missing_file_reads_as_nothing_running() {
    let dir = TempDir::new().unwrap();
    let list = read_claude_background_work(&dir.path().join("absent.jsonl"), None);
    assert_eq!(list, BackgroundWorkList::default());
}

#[test]
fn iso_timestamps_parse_to_unix_millis() {
    assert_eq!(parse_unix_ms(&iso(T0)), Some(T0));
    assert_eq!(
        parse_unix_ms("2026-10-18T07:10:18.568Z"),
        Some(1_792_307_418_568)
    );
    assert_eq!(
        parse_unix_ms("2026-10-18T07:10:18Z"),
        Some(1_792_307_418_000)
    );
    assert_eq!(parse_unix_ms("yesterday"), None);
}
