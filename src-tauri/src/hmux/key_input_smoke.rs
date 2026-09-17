// Real key-input byte oracle; called only inside the disposable managed fixture.
use super::{read_screen, wait_for_exact_markers};
use hmux_client::LocalSession;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Output;
use std::time::Duration;

pub(super) fn exercise(
    session: &LocalSession,
    state: &Path,
    registry: &Value,
    invoke: impl Fn(&[&str]) -> Result<Output, String>,
) -> Result<(), String> {
    let wait = |phase, marker| {
        wait_for_exact_markers(phase, [marker], Duration::from_secs(5), || {
            read_screen(session)
        })
    };
    wait("key_application_mode", "KEY_INPUT_READY")?;

    let invalid = invoke(&["send-keys", "command-input", "Up", "NotAKey", "--json"])?;
    require_not_written(&invalid, "invalid key batch")?;
    let mut stale_registry = registry.clone();
    stale_registry["agents"][0]["runtimeBinding"]["stopFence"]["terminalEpoch"] =
        "stale-epoch".into();
    let registry_path = state.join("agents.json");
    let write_registry = |value| {
        std::fs::write(&registry_path, serde_json::to_vec(value).unwrap())
            .map_err(|error| format!("write isolated key registry: {error}"))
    };
    write_registry(&stale_registry)?;
    let stale = invoke(&["send-keys", "command-input", "C-c", "--json"]);
    write_registry(registry)?;
    require_not_written(&stale?, "stale generation")?;

    let delivered = invoke(&[
        "send-keys",
        "command-input",
        "C-c",
        "Up",
        "Tab",
        "Backspace",
        "Escape",
        "Enter",
        "--json",
    ])?;
    require_written(&delivered, 6)?;
    // Ctrl+C, application-cursor Up, Tab, DEL, Escape, CR. Rejected calls must
    // not leave an input prefix, so the entire accumulated byte stream is checked.
    wait("semantic_key_bytes", "KEY_INPUT_BYTES:031b4f41097f1b0d")?;
    wait("key_normal_mode", "KEY_NORMAL_READY")?;
    let delivered = invoke(&["send-keys", "command-input", "Down", "Shift+Tab", "--json"])?;
    require_written(&delivered, 2)?;
    wait(
        "semantic_key_mode_change",
        "KEY_INPUT_BYTES:031b4f41097f1b0d1b5b421b5b5a",
    )?;
    Ok(())
}

fn require_not_written(output: &Output, context: &str) -> Result<(), String> {
    let report: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "{context}: invalid JSON: {error}; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    if output.status.success()
        || report["ok"] != false
        || report["error"]["deliveryState"] != "not_written"
    {
        return Err(format!("{context}: expected no input, got {report}"));
    }
    Ok(())
}

fn require_written(output: &Output, count: usize) -> Result<(), String> {
    let report: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "key receipt JSON: {error}; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    let keys = report["receipt"]["keys"].as_array();
    if !output.status.success()
        || report["apiVersion"] != "dure.send-keys/v1"
        || report["ok"] != true
        || !keys.is_some_and(|keys| {
            keys.len() == count && keys.iter().all(|key| key["state"] == "written_to_pty")
        })
    {
        return Err(format!("keys not delivered: {report}"));
    }
    Ok(())
}

pub(super) fn fixture() {
    print!("\x1b[?1h\r\nKEY_INPUT_READY\r\n");
    std::io::stdout().flush().unwrap();
    let mut received = Vec::new();
    loop {
        let mut buffer = [0; 128];
        let count = std::io::stdin().read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        received.extend_from_slice(&buffer[..count]);
        assert!(
            received.len() <= 128,
            "key fixture input exceeded its bound"
        );
        let hex = received
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        print!("\r\nKEY_INPUT_BYTES:{hex}\r\n");
        if received == b"\x03\x1bOA\t\x7f\x1b\r" {
            print!("\x1b[?1l\r\nKEY_NORMAL_READY\r\n");
        }
        std::io::stdout().flush().unwrap();
    }
}
