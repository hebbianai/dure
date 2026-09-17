use serde_json::Value;

pub(super) fn replayable_frontend_request(
    action: &str,
    params: &Value,
) -> Result<Option<(String, Value)>, String> {
    if !matches!(
        action,
        "agent.input" | "hmux.input" | "agent.reuse" | "pane.act"
    ) {
        return Ok(None);
    }
    let Some(idempotency_key) = params.get("idempotencyKey").and_then(Value::as_str) else {
        return Ok(None);
    };
    if idempotency_key.is_empty()
        || idempotency_key.len() > 128
        || !idempotency_key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(
            "idempotencyKey must be 1..=128 ASCII letters, numbers, hyphens, underscores, or dots"
                .to_string(),
        );
    }
    let request_prefix = match action {
        "agent.reuse" => "agent_reuse",
        "pane.act" => "pane_action",
        _ => "input",
    };
    Ok(Some((
        format!("{request_prefix}_{idempotency_key}"),
        serde_json::json!({
            "action": action,
            "params": params,
        }),
    )))
}

#[cfg(test)]
mod tests {
    use super::super::CliRequestBroker;
    use super::*;

    #[test]
    fn pane_action_retry_replays_the_actual_result_and_rejects_changed_arguments() {
        let broker = CliRequestBroker::default();
        let params = serde_json::json!({
            "targetPanelId": "agent:original", "actionId": "settings.effort",
            "arguments": { "value": "high" }, "idempotencyKey": "change-1"
        });
        let (id, identity) = replayable_frontend_request("pane.act", &params)
            .unwrap()
            .unwrap();
        let original = broker
            .register_with_identity(id.clone(), Some(identity.clone()))
            .unwrap();
        assert!(original.dispatch);
        assert!(broker.claim(&id).unwrap());
        drop(original.receiver);
        let receipt = serde_json::json!({ "ok": true, "pane": {
            "result": { "outcome": "refused", "error": { "code": "source_retained" } }
        }});
        broker.complete(&id, receipt.clone()).unwrap();
        let retry = broker
            .register_with_identity(id.clone(), Some(identity))
            .unwrap();
        assert!(!retry.dispatch);
        assert_eq!(retry.receiver.recv().unwrap(), receipt);
        let mut changed = params;
        changed["arguments"]["value"] = serde_json::json!("low");
        let (_, changed_identity) = replayable_frontend_request("pane.act", &changed)
            .unwrap()
            .unwrap();
        assert!(broker
            .register_with_identity(id, Some(changed_identity))
            .is_err());
    }
}
