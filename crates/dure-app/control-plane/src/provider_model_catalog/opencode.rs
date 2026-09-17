use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Model {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
    name: String,
}

/// OpenCode's public `models --verbose` command writes each namespaced ID
/// followed by one JSON model object. Do not parse terminal UI or auth files.
pub(super) fn parse(mut input: &[u8]) -> Result<Vec<Value>, &'static str> {
    let mut models = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    while !input.is_empty() {
        let offset = input.iter().position(|byte| !byte.is_ascii_whitespace());
        let Some(offset) = offset else { break };
        input = &input[offset..];
        let newline = input
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or("provider_catalog_protocol_invalid")?;
        let id = std::str::from_utf8(&input[..newline])
            .map_err(|_| "provider_catalog_protocol_invalid")?
            .trim_end_matches('\r');
        dure_app::AgentSpawnModelSelectionV1::parse(id)
            .map_err(|_| "provider_catalog_model_unsupported")?;
        let mut stream =
            serde_json::Deserializer::from_slice(&input[newline + 1..]).into_iter::<Model>();
        let model = stream
            .next()
            .ok_or("provider_catalog_protocol_invalid")?
            .map_err(|_| "provider_catalog_protocol_invalid")?;
        if id != format!("{}/{}", model.provider_id, model.id)
            || model.name.is_empty()
            || model.name.len() > 1024
            || !seen.insert(id.to_owned())
        {
            return Err("provider_catalog_protocol_invalid");
        }
        models.push(json!({
            "value": id,
            "displayName": model.name,
            // Native TUI has no reviewed effort argv. ACP variants must not
            // advertise a setting that the selected native runtime cannot apply.
            "supportsEffort": false,
            "supportedEffortLevels": [],
        }));
        input = &input[newline + 1 + stream.byte_offset()..];
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_incomplete_mismatched_or_duplicate_model_records() {
        for input in [
            "fixture/model\n{\"id\":\"model\"",
            "fixture/model\n{\"id\":\"other\",\"providerID\":\"fixture\",\"name\":\"Model\"}",
            "fixture/model\n{\"id\":\"model\",\"providerID\":\"fixture\",\"name\":\"Model\"}\nfixture/model\n{\"id\":\"model\",\"providerID\":\"fixture\",\"name\":\"Model\"}",
        ] {
            assert!(parse(input.as_bytes()).is_err());
        }
    }
}
