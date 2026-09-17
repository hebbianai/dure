use super::*;
use std::fs;
use std::time::Duration;
use tempfile::TempDir;

#[tokio::test]
async fn independent_backend_scopes_do_not_share_provider_resource_names() {
    let first = Fixture::new(&success_script(), "true");
    let second = Fixture::new(&success_script(), "true");
    let a = first.call(true, first.create_request("task-42")).unwrap();
    let b = second.call(true, second.create_request("task-42")).unwrap();
    assert_ne!(a["environment"]["id"], b["environment"]["id"]);
    first
        .settled(a["environment"]["id"].as_str().unwrap())
        .await;
    second
        .settled(b["environment"]["id"].as_str().unwrap())
        .await;
}

#[tokio::test]
async fn provider_child_inherits_the_operation_directory_capability() {
    let fixture = Fixture::new("true", "true");
    let script = format!(
        r#"python3 - <<'PY'
import os
target = os.stat(".")
found = False
for fd in range(3, 256):
    try:
        stat = os.fstat(fd)
        found = found or (stat.st_dev, stat.st_ino) == (target.st_dev, target.st_ino)
    except OSError:
        pass
assert found, "provider lost the operation lock at exec"
PY
status=$?
if [ "$status" != 0 ]; then exit "$status"; fi
{}"#,
        success_script()
    );
    fs::write(fixture.project.path().join("create.sh"), script).unwrap();
    let started = fixture
        .call(true, fixture.create_request("inherit-lock"))
        .unwrap();
    let record = fixture
        .settled(started["environment"]["id"].as_str().unwrap())
        .await;
    assert_eq!(record["status"], "running", "{record}");
}

#[tokio::test]
async fn captured_cleanup_survives_source_project_removal() {
    let fixture = Fixture::new("true", "true");
    fs::write(
        fixture.project.path().join("create.sh"),
        format!("touch owned-resource\n{}", success_script()),
    )
    .unwrap();
    fs::write(
        fixture.project.path().join("destroy.sh"),
        "rm -f owned-resource",
    )
    .unwrap();
    let started = fixture
        .call(true, fixture.create_request("source-removed"))
        .unwrap();
    let id = started["environment"]["id"].as_str().unwrap();
    let running = fixture.settled(id).await;
    let marker = Store::open(fixture.root.path())
        .unwrap()
        .workdir(id)
        .unwrap()
        .join("owned-resource");
    assert!(marker.exists());
    fs::remove_dir_all(fixture.project.path()).unwrap();
    fixture
        .transition(false, &running, "destroy", "cleanup")
        .unwrap();
    assert_eq!(fixture.settled(id).await["status"], "destroyed");
    assert!(!marker.exists());
}

struct Fixture {
    root: TempDir,
    project: TempDir,
}

impl Fixture {
    fn new(create: &str, destroy: &str) -> Self {
        let fixture = Self {
            root: tempfile::tempdir().unwrap(),
            project: tempfile::tempdir().unwrap(),
        };
        fs::write(
            fixture.project.path().join("create.sh"),
            format!("cd \"$DURE_PROJECT_PATH\"\n{create}"),
        )
        .unwrap();
        fs::write(
            fixture.project.path().join("destroy.sh"),
            format!("cd \"$DURE_PROJECT_PATH\"\n{destroy}"),
        )
        .unwrap();
        fs::write(
            fixture.project.path().join("suspend.sh"),
            "cd \"$DURE_PROJECT_PATH\"\ntouch suspended",
        )
        .unwrap();
        fs::write(fixture.project.path().join("resume.sh"), success_script()).unwrap();
        fs::write(fixture.project.path().join(recipe::MANIFEST), json!({
            "schemaVersion": 1,
            "environments": [{"id":"test","name":"Test","create":"create.sh","destroy":"destroy.sh",
                "suspend":"suspend.sh","resume":"resume.sh"}],
        }).to_string()).unwrap();
        fixture
    }

    fn call(&self, pro: bool, mut body: Value) -> Result<Value, &'static str> {
        body["schemaVersion"] = json!(1);
        dispatch(
            self.root.path(),
            &self.root.path().to_string_lossy(),
            "generation-a",
            pro,
            &body,
        )
    }

    fn create_request(&self, key: &str) -> Value {
        let recipes = self
            .call(
                true,
                json!({"action":"recipes","projectPath":self.project.path()}),
            )
            .unwrap();
        json!({"action":"create","projectPath":self.project.path(),"recipeId":"test",
            "recipeDigest":recipes["recipes"][0]["digest"],"name":"Workspace","idempotencyKey":key})
    }

    async fn settled(&self, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let list = self.call(true, json!({"action":"list"})).unwrap();
                let record = list["environments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|record| record["id"] == id)
                    .unwrap()
                    .clone();
                if !["creating", "suspending", "resuming", "destroying"]
                    .contains(&record["status"].as_str().unwrap())
                {
                    return record;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    fn transition(
        &self,
        pro: bool,
        record: &Value,
        operation: &str,
        key: &str,
    ) -> Result<Value, &'static str> {
        self.call(
            pro,
            json!({"action":"transition","id":record["id"],"expectedRevision":record["revision"],
            "operation":operation,"idempotencyKey":key}),
        )
    }
}

fn result() -> Value {
    json!({"schemaVersion":1,"resourceId":"test-resource",
        "connection":{"host":"127.0.0.1","port":2222,"user":"developer","projectRoot":"/workspace"},
        "userData":{"providerToken":"private-test-value"}})
}

fn success_script() -> String {
    format!("printf '%s\\n' '{}'", result())
}

#[tokio::test]
async fn pro_admission_happens_before_provider_or_store_access() {
    let root = tempfile::tempdir().unwrap();
    let body = json!({"schemaVersion":1,"action":"create","projectPath":"/nonexistent",
        "recipeId":"test","recipeDigest":"unused","name":"Test","idempotencyKey":"key"});
    assert_eq!(
        dispatch(root.path(), "scope-test", "g", false, &body),
        Err("pro_required")
    );
    assert!(!root.path().join("workspace-environments").exists());
    assert_eq!(
        dispatch(
            root.path(),
            "scope-test",
            "g",
            false,
            &json!({"schemaVersion":1,"action":"transition",
        "id":"unused","expectedRevision":1,"operation":"resume","idempotencyKey":"key"})
        ),
        Err("pro_required")
    );
}

#[tokio::test]
async fn lifecycle_is_durable_idempotent_and_cleanup_survives_basic_mode() {
    let create = format!(
        "echo created >> calls\ntouch resource\n{}",
        success_script()
    );
    let fixture = Fixture::new(&create, "rm -f resource");
    let request = fixture.create_request("first");
    let started = fixture.call(true, request.clone()).unwrap();
    let id = started["environment"]["id"].as_str().unwrap();
    // The acknowledgement already has a durable pending record.
    let store = Store::open(fixture.root.path()).unwrap();
    assert_eq!(store.read(id).unwrap().unwrap().status, Status::Creating);
    assert!(fixture.call(true, request.clone()).is_ok());
    let running = fixture.settled(id).await;
    assert_eq!(running["status"], "running");
    assert!(!running.to_string().contains("private-test-value"));
    assert!(fixture.call(true, request).is_ok());
    assert_eq!(
        fs::read_to_string(fixture.project.path().join("calls")).unwrap(),
        "created\n"
    );

    assert_eq!(
        fixture.transition(true, &started["environment"], "suspend", "stale"),
        Err("environment_revision_changed")
    );
    fixture
        .transition(false, &running, "suspend", "sleep")
        .unwrap();
    let suspended = fixture.settled(id).await;
    assert_eq!(suspended["status"], "suspended");
    assert!(fixture.project.path().join("suspended").exists());
    fixture
        .transition(true, &suspended, "resume", "wake")
        .unwrap();
    let resumed = fixture.settled(id).await;
    assert_eq!(resumed["status"], "running");

    // Later edits to the repository must not replace the captured destructor.
    fs::write(fixture.project.path().join("destroy.sh"), "exit 99").unwrap();
    fixture
        .transition(false, &resumed, "destroy", "delete")
        .unwrap();
    let destroyed = fixture.settled(id).await;
    assert_eq!(destroyed["status"], "destroyed");
    assert!(!fixture.project.path().join("resource").exists());
    assert!(
        fixture
            .transition(false, &resumed, "destroy", "delete")
            .is_ok()
    );
}

#[tokio::test]
async fn malformed_create_compensates_using_preallocated_id() {
    let fixture = Fixture::new(
        "touch \"$DURE_ENVIRONMENT_ID\"\nprintf 'not json'",
        "rm -f \"$DURE_ENVIRONMENT_ID\"",
    );
    let created = fixture
        .call(true, fixture.create_request("malformed"))
        .unwrap();
    let id = created["environment"]["id"].as_str().unwrap();
    let final_record = fixture.settled(id).await;
    assert_eq!(final_record["status"], "destroyed");
    assert_eq!(final_record["error"], "environment_result_invalid");
    assert!(!fixture.project.path().join(id).exists());
}

#[tokio::test]
async fn failed_cleanup_is_retained_and_can_be_retried() {
    let fixture = Fixture::new(
        "touch resource; exit 8",
        "if [ ! -f retry ]; then touch retry; exit 9; fi; rm -f resource",
    );
    let created = fixture
        .call(true, fixture.create_request("cleanup"))
        .unwrap();
    let id = created["environment"]["id"].as_str().unwrap();
    let failed = fixture.settled(id).await;
    assert_eq!(failed["status"], "cleanup_failed");
    assert!(fixture.project.path().join("resource").exists());
    fixture
        .transition(false, &failed, "destroy", "retry")
        .unwrap();
    assert_eq!(fixture.settled(id).await["status"], "destroyed");
    assert!(!fixture.project.path().join("resource").exists());
}

#[tokio::test]
async fn changed_recipe_or_conflicting_request_never_provisions() {
    let fixture = Fixture::new(&success_script(), "true");
    let request = fixture.create_request("fenced");
    fs::write(fixture.project.path().join("create.sh"), "touch unintended").unwrap();
    assert_eq!(
        fixture.call(true, request),
        Err("environment_recipe_changed")
    );
    assert!(!fixture.project.path().join("unintended").exists());
    fs::write(fixture.project.path().join("create.sh"), success_script()).unwrap();
    let mut request = fixture.create_request("fenced");
    let started = fixture.call(true, request.clone()).unwrap();
    request["name"] = json!("Other");
    assert_eq!(
        fixture.call(true, request),
        Err("environment_idempotency_conflict")
    );
    fixture
        .settled(started["environment"]["id"].as_str().unwrap())
        .await;
}

#[tokio::test]
async fn lock_prevents_recovery_of_live_operations_and_released_lock_recovers() {
    let fixture = Fixture::new(&success_script(), "true");
    let created = fixture
        .call(true, fixture.create_request("restart"))
        .unwrap();
    let id = created["environment"]["id"].as_str().unwrap();
    fixture.settled(id).await;
    let store = Store::open(fixture.root.path()).unwrap();
    let lock = store.lock(id).unwrap();
    let mut record = store.read(id).unwrap().unwrap();
    record.status = Status::Destroying;
    store.write(&record).unwrap();
    assert_eq!(
        fixture.call(true, json!({"action":"list"})).unwrap()["environments"][0]["status"],
        "destroying"
    );
    assert_eq!(
        fixture.transition(false, &projection(&record), "destroy", "blocked"),
        Err("environment_busy")
    );
    drop(lock);
    let recovered =
        fixture.call(false, json!({"action":"list"})).unwrap()["environments"][0].clone();
    assert_eq!(recovered["status"], "cleanup_failed");
    assert_eq!(recovered["error"], "environment_operation_interrupted");
    fixture
        .transition(false, &recovered, "destroy", "retry")
        .unwrap();
    assert_eq!(fixture.settled(id).await["status"], "destroyed");
}

#[test]
fn invalid_connections_and_escaping_scripts_are_rejected() {
    for (field, invalid) in [
        ("host", json!("-oProxyCommand=bad")),
        ("port", json!(0)),
        ("user", json!("bad user")),
        ("projectRoot", json!("relative")),
    ] {
        let mut value = result();
        value["connection"][field] = invalid;
        assert!(process::parse_result(value.to_string().as_bytes()).is_err());
    }
    let fixture = Fixture::new("true", "true");
    let external = tempfile::NamedTempFile::new().unwrap();
    fs::remove_file(fixture.project.path().join("create.sh")).unwrap();
    std::os::unix::fs::symlink(external.path(), fixture.project.path().join("create.sh")).unwrap();
    assert_eq!(
        recipe::catalog(fixture.project.path()).unwrap_err(),
        "environment_script_outside_project"
    );
}

#[tokio::test]
async fn invalid_store_cannot_run_a_script() {
    let fixture = Fixture::new("touch unintended", "true");
    // Acquire the reviewed digest before replacing the service's data directory.
    let request = fixture.create_request("storage");
    let directory = fixture.root.path().join("workspace-environments");
    fs::remove_dir(&directory).unwrap();
    std::os::unix::fs::symlink(fixture.project.path(), directory).unwrap();
    assert_eq!(
        fixture.call(true, request),
        Err("environment_store_invalid")
    );
    assert!(!fixture.project.path().join("unintended").exists());
}
