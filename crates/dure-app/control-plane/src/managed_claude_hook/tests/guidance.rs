use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(directory: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(arguments)
        .status()
        .unwrap();
    assert!(status.success(), "git {arguments:?}");
}

/// A repository with one commit, a subdirectory and a linked worktree.
fn repository() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let checkout = root.path().canonicalize().unwrap().join("checkout");
    std::fs::create_dir_all(checkout.join("src")).unwrap();
    git(&checkout, &["init", "-q"]);
    std::fs::write(checkout.join("src/file.txt"), "fixture").unwrap();
    git(&checkout, &["add", "."]);
    git(&checkout, &["commit", "-q", "-m", "fixture"]);
    git(
        &checkout,
        &["worktree", "add", "-q", "-b", "feature", "../linked"],
    );
    (root, checkout)
}

fn session_start(cwd: &Path) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "fixture-session",
        "cwd": cwd,
    }))
    .unwrap()
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn additional_context(output: &str) -> String {
    let value: Value = serde_json::from_str(output).unwrap();
    assert_eq!(value["hookSpecificOutput"]["hookEventName"], "SessionStart");
    value["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn session_start_in_the_primary_checkout_receives_guidance() {
    let (_root, checkout) = repository();
    let output = session_start_guidance(&session_start(&checkout), Path::new("/"), deadline())
        .await
        .unwrap();
    let context = additional_context(&output);
    assert!(
        context.contains(&format!("at {} (currently on main)", checkout.display())),
        "{context}"
    );
}

#[tokio::test]
async fn a_subdirectory_names_the_checkout_root() {
    let (_root, checkout) = repository();
    let output = session_start_guidance(
        &session_start(&checkout.join("src")),
        Path::new("/"),
        deadline(),
    )
    .await
    .unwrap();
    assert!(additional_context(&output).contains(&format!("at {} (", checkout.display())));
}

#[tokio::test]
async fn a_linked_worktree_receives_no_guidance() {
    let (_root, checkout) = repository();
    let linked = checkout.parent().unwrap().join("linked");
    assert_eq!(
        session_start_guidance(&session_start(&linked), Path::new("/"), deadline()).await,
        None
    );
}

#[tokio::test]
async fn a_directory_outside_git_receives_no_guidance() {
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(
        session_start_guidance(&session_start(outside.path()), Path::new("/"), deadline()).await,
        None
    );
}

#[tokio::test]
async fn other_events_receive_no_guidance() {
    let (_root, checkout) = repository();
    let body = serde_json::to_vec(&serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "fixture-session",
        "cwd": checkout,
    }))
    .unwrap();
    assert_eq!(
        session_start_guidance(&body, Path::new("/"), deadline()).await,
        None
    );
}

#[tokio::test]
async fn a_payload_without_cwd_uses_the_hook_directory() {
    let (_root, checkout) = repository();
    let body = serde_json::to_vec(&serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "fixture-session",
    }))
    .unwrap();
    let output = session_start_guidance(&body, &checkout, deadline())
        .await
        .unwrap();
    assert!(additional_context(&output).contains(&format!("at {} (", checkout.display())));
}

#[tokio::test]
async fn an_expired_deadline_skips_the_query() {
    let (_root, checkout) = repository();
    assert_eq!(
        session_start_guidance(&session_start(&checkout), Path::new("/"), Instant::now()).await,
        None
    );
}

#[test]
fn guidance_keeps_a_failed_report_from_hiding_it() {
    assert_eq!(completed(Err(HookFailure::Unavailable), true), Ok(()));
    assert_eq!(
        completed(Err(HookFailure::Unavailable), false),
        Err(HookFailure::Unavailable)
    );
    assert_eq!(completed(Ok(()), false), Ok(()));
}
