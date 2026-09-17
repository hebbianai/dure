use super::*;

fn is_recovering_receipt(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes).is_ok_and(|report| {
        report
            == json!({
                "schemaVersion": 1,
                "apiVersion": "dure.local-backend/v1",
                "kind": "dure.local_backend.receipt",
                "profile": null,
                "status": "recovering",
                "retryable": true,
                "error": {
                    "code": "recovering",
                    "message": "the local backend is switching to a verified generation; retry this operation"
                }
            })
    })
}

pub(super) fn is_recovering_output(output: &Output) -> bool {
    if output.status.code() != Some(2) {
        return false;
    }
    if output.stderr.is_empty() {
        return is_recovering_receipt(&output.stdout);
    }
    output.stdout.is_empty()
        && serde_json::from_slice::<Value>(&output.stderr).is_ok_and(|report| {
            report
                == json!({
                    "schemaVersion": 1,
                    "apiVersion": "dure.backend-reconcile/v1",
                    "kind": "dure.backend.reconcile_error",
                    "error": {
                        "code": "recovering",
                        "message": "the local backend is switching to a verified generation; retry this operation"
                    }
                })
        })
}

pub(super) fn output_with_recovery(command: &mut Command) -> Output {
    let output = command.output().unwrap();
    // A request racing a backend generation switch legitimately sees the
    // canonical retry_same "recovering" receipt once. Retry exactly once.
    if is_recovering_output(&output) {
        command.output().unwrap()
    } else {
        output
    }
}

#[test]
fn reconcile_receipt_retries_once_and_preserves_nonrecovering_failures() {
    let temporary = tempfile::tempdir().unwrap();
    let script = temporary.path().join("reconcile.mjs");
    fs::write(
        &script,
        r#"
import fs from "node:fs";
const { runBackendReconcileFromCli } = await import(process.argv[2]);
const [counter, code, failUntil] = process.argv.slice(3);
const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) + 1 : 1;
fs.writeFileSync(counter, String(attempt));
process.exitCode = await runBackendReconcileFromCli({
  json: true,
  prepareBackendProfile: async () => {
    if (attempt <= Number(failUntil)) {
      const error = new Error("the local backend is switching to a verified generation; retry this operation");
      error.code = code;
      throw error;
    }
    return {
      managedLocal: true,
      source: "fixture",
      profile: { id: "local", transport: { kind: "unix" }, expected: { backendId: "dure-local", generation: "fixture" } },
    };
  },
});
"#,
    )
    .unwrap();
    for (code, failures, expected_attempts, expected_status) in [
        ("recovering", 1, 2, 0),
        ("recovering", 2, 2, 2),
        ("local_backend_descriptor_changed", 1, 1, 2),
    ] {
        let counter = temporary.path().join(format!("{code}-{failures}"));
        let mut command = Command::new("node");
        command
            .arg(&script)
            .arg(repository_root().join("cli/lib/backend-reconcile.mjs"))
            .arg(&counter)
            .arg(code)
            .arg(failures.to_string());
        let output = output_with_recovery(&mut command);
        assert_eq!(
            fs::read_to_string(counter).unwrap(),
            expected_attempts.to_string(),
            "{code}, failUntil={failures}"
        );
        assert_eq!(output.status.code(), Some(expected_status));
        if expected_status == 0 {
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["status"], "ready");
            assert!(output.stderr.is_empty());
        } else {
            let report: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert_eq!(report["error"]["code"], code);
            assert!(output.stdout.is_empty());
        }
    }
}
