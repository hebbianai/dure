use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value};

const FAULT_DIGEST_ENV: &str = "DURE_QA_FAIL_PROMPT_SUCCESS_APPEND_ONCE";
const HOST_ATOMIC_CONTRACT: &str = "host_atomic_v1";
static FAULT_CONSUMED: AtomicBool = AtomicBool::new(false);

fn prompt_success_digest(event: &Map<String, Value>) -> Option<&str> {
    (event.get("event").and_then(Value::as_str) == Some("step_succeeded")
        && event.get("step").and_then(Value::as_str) == Some("prompt_delivery")
        && event
            .get("detail")
            .and_then(|detail| detail.get("deliveryContract"))
            .and_then(Value::as_str)
            == Some(HOST_ATOMIC_CONTRACT))
    .then(|| {
        event
            .get("detail")
            .and_then(|detail| detail.get("promptDigest"))
            .and_then(Value::as_str)
    })
    .flatten()
}

/// Drop one already-validated Host success before its journal append. This is
/// compiled only into debug apps and exists solely to prove reload recovery at
/// the otherwise unobservable Host-receipt/journal boundary.
pub(super) fn fail_prompt_success_append_once(
    receipt_id: &str,
    event: &Map<String, Value>,
) -> Result<(), String> {
    let Ok(expected_digest) = std::env::var(FAULT_DIGEST_ENV) else {
        return Ok(());
    };
    if prompt_success_digest(event) != Some(expected_digest.as_str()) {
        return Ok(());
    }
    if FAULT_CONSUMED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    Err(format!(
        "qa_prompt_success_append_failed:{receipt_id}:{expected_digest}"
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::prompt_success_digest;

    #[test]
    fn selects_only_host_atomic_prompt_success() {
        let success = json!({
            "event": "step_succeeded",
            "step": "prompt_delivery",
            "detail": {
                "deliveryContract": "host_atomic_v1",
                "promptDigest": "sha256:abc"
            }
        });
        assert_eq!(
            prompt_success_digest(success.as_object().unwrap()),
            Some("sha256:abc")
        );

        for other in [
            json!({
                "event": "step_succeeded",
                "step": "provider_exec",
                "detail": {
                    "deliveryContract": "host_atomic_v1",
                    "promptDigest": "sha256:abc"
                }
            }),
            json!({
                "event": "step_failed",
                "step": "prompt_delivery",
                "detail": {
                    "deliveryContract": "host_atomic_v1",
                    "promptDigest": "sha256:abc"
                }
            }),
        ] {
            assert_eq!(prompt_success_digest(other.as_object().unwrap()), None);
        }
    }
}
