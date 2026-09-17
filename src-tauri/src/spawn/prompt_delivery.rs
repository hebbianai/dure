use serde_json::{json, Map, Value};

const HOST_ATOMIC_PROMPT_DELIVERY_CONTRACT: &str = "host_atomic_v1";

pub(super) fn prompt_failure_is_unverified(error: &Value) -> bool {
    match error.get("deliveryState") {
        Some(Value::String(state)) if state == "unknown" => true,
        Some(Value::String(state)) if state == "not_written" => false,
        Some(_) => true,
        None => error.get("code").and_then(Value::as_str) == Some("prompt_delivery_unverified"),
    }
}

fn valid_prompt_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub(super) fn prompt_identity(value: &Value) -> Option<(&str, u64)> {
    let object = value.as_object()?;
    let digest = object
        .get("promptDigest")
        .and_then(Value::as_str)
        .filter(|value| valid_prompt_digest(value))?;
    let prompt_len = object
        .get("promptLen")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)?;
    Some((digest, prompt_len))
}

pub(super) fn prompt_step(receipt: &Value) -> Option<&Map<String, Value>> {
    receipt
        .get("steps")?
        .as_array()?
        .iter()
        .find(|step| step.get("step").and_then(Value::as_str) == Some("prompt_delivery"))?
        .as_object()
}

fn canonical_u64(value: &Value, positive: bool) -> Option<&str> {
    let value = value.as_str()?;
    let parsed = value.parse::<u64>().ok()?;
    if (positive && parsed == 0) || parsed.to_string() != value {
        return None;
    }
    Some(value)
}

/// Parses the host-atomic success append into its durable delivery projection.
/// The generic step success commits completion and the exact Host receipt, so
/// no frontend readiness, intent, or evidence event is needed on this path.
pub(super) fn host_atomic_prompt_delivery(
    event: &Map<String, Value>,
    request: &Value,
    prior_step: Option<&Map<String, Value>>,
) -> Result<Option<Value>, String> {
    if event.get("event").and_then(Value::as_str) != Some("step_succeeded")
        || event.get("step").and_then(Value::as_str) != Some("prompt_delivery")
    {
        return Ok(None);
    }
    let prior_contract = prior_step
        .and_then(|step| step.get("detail"))
        .and_then(|detail| detail.get("deliveryContract"))
        .and_then(Value::as_str);
    let detail = event.get("detail").and_then(Value::as_object);
    let success_contract = detail
        .and_then(|detail| detail.get("deliveryContract"))
        .and_then(Value::as_str);
    if prior_contract != Some(HOST_ATOMIC_PROMPT_DELIVERY_CONTRACT)
        && success_contract != Some(HOST_ATOMIC_PROMPT_DELIVERY_CONTRACT)
    {
        return Ok(None);
    }
    let prior_step = prior_step.ok_or("host-atomic prompt success requires its step start")?;
    if prior_contract != Some(HOST_ATOMIC_PROMPT_DELIVERY_CONTRACT)
        || prior_step.get("status").and_then(Value::as_str) != Some("running")
    {
        return Err("host-atomic prompt success requires its matching running step".into());
    }
    let detail = detail.ok_or("host-atomic prompt success requires detail")?;
    if success_contract != Some(HOST_ATOMIC_PROMPT_DELIVERY_CONTRACT) {
        return Err("host-atomic prompt success requires its delivery contract".into());
    }
    let detail_value = Value::Object(detail.clone());
    let detail_identity = prompt_identity(&detail_value)
        .ok_or("host-atomic prompt success requires a valid prompt identity")?;
    let request_identity = prompt_identity(request)
        .ok_or("host-atomic prompt success requires a durable request identity")?;
    if detail_identity != request_identity {
        return Err("host-atomic prompt success does not match the durable request".into());
    }
    let receipt = detail
        .get("receipt")
        .and_then(Value::as_object)
        .ok_or("host-atomic prompt success requires a Host receipt")?;
    let terminal_epoch = receipt
        .get("terminalEpoch")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("host-atomic prompt receipt requires a terminal epoch")?;
    let record_id = receipt
        .get("recordId")
        .and_then(|value| canonical_u64(value, true))
        .ok_or("host-atomic prompt receipt requires a positive record id")?;
    let input_baseline_output_sequence = receipt
        .get("inputBaselineOutputSequence")
        .and_then(|value| canonical_u64(value, false))
        .ok_or("host-atomic prompt receipt requires an output baseline")?;
    let initial_agent_runtime_revision = receipt
        .get("initialAgentRuntimeRevision")
        .map(|value| {
            canonical_u64(value, true)
                .ok_or("host-atomic prompt receipt runtime revision is invalid")
        })
        .transpose()?;

    let mut projected_receipt = Map::new();
    projected_receipt.insert("terminalEpoch".into(), json!(terminal_epoch));
    projected_receipt.insert("recordId".into(), json!(record_id));
    projected_receipt.insert(
        "inputBaselineOutputSequence".into(),
        json!(input_baseline_output_sequence),
    );
    if let Some(revision) = initial_agent_runtime_revision {
        projected_receipt.insert("initialAgentRuntimeRevision".into(), json!(revision));
    }
    Ok(Some(json!({
        "state": "written_to_pty",
        "promptDigest": detail_identity.0,
        "promptLen": detail_identity.1,
        "receipt": projected_receipt,
    })))
}
