use super::*;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

fn claude_record(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"assistant","message":{"content":text}})
    )
}

fn write_at(path: &Path, content: &str, modified_secs: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(modified_secs))
        .unwrap();
}

fn owned(_: &fs::Metadata) -> bool {
    true
}

#[test]
fn default_roots_follow_each_provider_override_and_ignore_an_empty_one() {
    let home = Path::new("/home/person");
    let defaults = ProviderStateRoots::resolve(home, None, None);
    assert_eq!(
        defaults.claude_projects,
        Path::new("/home/person/.claude/projects")
    );
    assert_eq!(
        defaults.codex_sessions,
        Path::new("/home/person/.codex/sessions")
    );

    let overridden = ProviderStateRoots::resolve(
        home,
        Some(OsString::from("/state/claude")),
        Some(OsString::from("/state/codex")),
    );
    assert_eq!(
        overridden.claude_projects,
        Path::new("/state/claude/projects")
    );
    assert_eq!(
        overridden.codex_sessions,
        Path::new("/state/codex/sessions")
    );

    let empty = ProviderStateRoots::resolve(home, Some(OsString::new()), Some(OsString::new()));
    assert_eq!(empty, defaults);
}

#[cfg(unix)]
#[test]
fn account_profiles_are_owned_real_directories_named_for_the_provider() {
    let home = tempfile::tempdir().unwrap();
    let accounts = home.path().join(".dure").join("accounts");
    for name in [
        "claude-work",
        "claude-other",
        "codex-work",
        "claude-unowned",
    ] {
        fs::create_dir_all(accounts.join(name)).unwrap();
    }
    fs::write(accounts.join("claude-file"), "not a directory").unwrap();
    std::os::unix::fs::symlink(accounts.join("claude-work"), accounts.join("claude-link")).unwrap();
    let unowned = fs::canonicalize(accounts.join("claude-unowned")).unwrap();
    let not_unowned = |metadata: &fs::Metadata| {
        use std::os::unix::fs::MetadataExt;
        let unowned = fs::metadata(&unowned).unwrap();
        (metadata.dev(), metadata.ino()) != (unowned.dev(), unowned.ino())
    };

    let mut found = account_profile_directories(home.path(), "claude", not_unowned);
    found.sort();
    let canonical = fs::canonicalize(&accounts).unwrap();
    assert_eq!(
        found,
        [
            canonical.join("claude-other"),
            canonical.join("claude-work")
        ]
    );
    assert_eq!(
        account_profile_directories(home.path(), "codex", owned),
        [canonical.join("codex-work")]
    );
    assert!(account_profile_directories(home.path(), "gemini", owned).is_empty());
}

#[cfg(unix)]
#[test]
fn account_profiles_need_an_owned_real_account_root() {
    let home = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    fs::create_dir_all(elsewhere.path().join("accounts").join("claude-work")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), home.path().join(".dure")).unwrap();
    assert!(account_profile_directories(home.path(), "claude", owned).is_empty());

    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".dure/accounts/claude-work")).unwrap();
    assert!(account_profile_directories(home.path(), "claude", |_| false).is_empty());
    assert!(
        account_profile_directories(Path::new("/nonexistent-home"), "claude", owned).is_empty()
    );
}

#[test]
fn the_newest_copy_across_the_default_root_and_profiles_is_read() {
    let home = tempfile::tempdir().unwrap();
    let roots = ProviderStateRoots::resolve(home.path(), None, None);
    let profile = home.path().join(".dure/accounts/claude-work");
    write_at(
        &roots.claude_projects.join("-project/conversation-1.jsonl"),
        &claude_record("from the default root"),
        1_000,
    );
    write_at(
        &profile.join("projects/-project/conversation-1.jsonl"),
        &claude_record("from the account profile"),
        2_000,
    );
    let read = read_newest(
        &roots,
        std::slice::from_ref(&profile),
        "claude",
        "conversation-1",
    )
    .unwrap();
    assert_eq!(read.entries[0].text, "from the account profile");

    write_at(
        &roots.claude_projects.join("-project/conversation-1.jsonl"),
        &claude_record("newer in the default root"),
        3_000,
    );
    let read = read_newest(&roots, &[profile], "claude", "conversation-1").unwrap();
    assert_eq!(read.entries[0].text, "newer in the default root");
}

#[test]
fn a_codex_rollout_is_found_in_a_profile_and_its_archive() {
    let home = tempfile::tempdir().unwrap();
    let roots = ProviderStateRoots::resolve(home.path(), None, None);
    let profile = home.path().join(".dure/accounts/codex-work");
    let id = "019a0000-0000-7000-8000-000000000001";
    let rollout = |text: &str| {
        format!(
            "{}\n{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":id}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
        )
    };
    write_at(
        &profile.join(format!(
            "sessions/2026/11/03/rollout-2026-11-03T00-00-00-{id}.jsonl"
        )),
        &rollout("active rollout"),
        1_000,
    );
    let read = read_newest(&roots, std::slice::from_ref(&profile), "codex", id).unwrap();
    assert_eq!(read.entries[0].text, "active rollout");

    write_at(
        &profile.join(format!(
            "archived_sessions/rollout-2026-11-03T00-00-00-{id}.jsonl"
        )),
        &rollout("archived later"),
        2_000,
    );
    let read = read_newest(&roots, &[profile], "codex", id).unwrap();
    assert_eq!(read.entries[0].text, "archived later");
}

#[test]
fn a_conversation_nobody_holds_is_not_found_and_an_unsafe_id_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let roots = ProviderStateRoots::resolve(home.path(), None, None);
    assert_eq!(
        read_newest(&roots, &[], "claude", "absent").unwrap_err(),
        "provider conversation was not found"
    );
    assert_eq!(
        read_newest(&roots, &[], "claude", "../escape").unwrap_err(),
        "provider conversation id is invalid"
    );
    assert_eq!(
        read_newest(&roots, &[], "gemini", "conversation").unwrap_err(),
        "provider transcript export is unsupported"
    );
}
