use super::{Monitor, field};
use hmux_host::browser_network::BrowserNetworkId;
use hmux_host::browser_resource::console::BrowserConsoleMessage;
use hmux_session_protocol::browser_console::BrowserConsoleKind;
use serde_json::Value;
mod contexts;
pub(super) use contexts::ConsoleContexts;

fn argument(value: &Value) -> String {
    if let Some(value) = value.get("value") {
        return value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
    }
    value["unserializableValue"]
        .as_str()
        .or_else(|| value["description"].as_str())
        .or_else(|| value["type"].as_str())
        .unwrap_or("")
        .to_owned()
}

impl Monitor {
    pub(super) async fn console_event(&mut self, event: &Value) -> Result<bool, &'static str> {
        if self.contexts.observe(event)? {
            return Ok(true);
        }
        let method = field(event, "method")?;
        if !matches!(
            method,
            "Runtime.consoleAPICalled" | "Runtime.exceptionThrown"
        ) {
            return Ok(false);
        }
        let source = BrowserNetworkId::new(field(event, "sessionId")?)?;
        let params = &event["params"];
        let timestamp = params["timestamp"]
            .as_f64()
            .ok_or("browser_console_timestamp_invalid")?;
        let mut objects = Vec::new();
        let (kind, level, text, location) = if method == "Runtime.consoleAPICalled" {
            let args = params["args"]
                .as_array()
                .ok_or("browser_console_arguments_invalid")?;
            let text = args.iter().map(argument).collect::<Vec<_>>().join(" ");
            objects.extend(
                args.iter()
                    .filter_map(|arg| arg["objectId"].as_str().map(str::to_owned)),
            );
            (
                BrowserConsoleKind::Console,
                field(params, "type")?,
                text,
                &params["stackTrace"]["callFrames"][0],
            )
        } else {
            let details = &params["exceptionDetails"];
            let exception = &details["exception"];
            if let Some(id) = exception["objectId"].as_str() {
                objects.push(id.to_owned());
            }
            let text = exception["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .ok_or("browser_console_exception_invalid")?
                .to_owned();
            (BrowserConsoleKind::Exception, "error", text, details)
        };
        let target = {
            let mut host = self.host.lock().await;
            let target = host.network().source_target(&source).cloned();
            host.console_observed(
                &source,
                BrowserConsoleMessage {
                    kind,
                    level,
                    text: &text,
                    timestamp,
                    url: location["url"].as_str(),
                    line: location["lineNumber"]
                        .as_u64()
                        .and_then(|line| u32::try_from(line).ok()),
                    column: location["columnNumber"]
                        .as_u64()
                        .and_then(|column| u32::try_from(column).ok()),
                },
            )?;
            target
        };
        if objects.is_empty() {
            return Ok(true);
        }
        let context = if method == "Runtime.consoleAPICalled" {
            &params["executionContextId"]
        } else {
            &params["exceptionDetails"]["executionContextId"]
        };
        let context = context.as_i64().ok_or("browser_console_context_invalid")?;
        let mut lifetime = self.contexts.scope(&source, context)?;
        let current = lifetime.clone();
        let barriers = self.barriers.clone();
        let resource = self.resource.clone();
        // Engine mirrors still need release when a preceding page census has
        // already removed their Host history. The engine context owns cleanup.
        let cdp = match target {
            Some(target) => super::super::execution::renderer_cdp(
                &self.host,
                &self.changed,
                self.cdp.clone(),
                target,
                None,
            ),
            None => self.cdp.clone(),
        };
        cdp.release_objects(
            source.as_str().to_owned(),
            objects,
            async move {
                let _ = lifetime.changed().await;
            },
            move || {
                let current = current.clone();
                let barriers = barriers.clone();
                let resource = resource.clone();
                async move {
                    // A protocol rejection may race earlier context-destroyed
                    // events still waiting on this same retained connection.
                    super::synchronize_events(&barriers, &resource).await?;
                    Ok(current.has_changed().is_ok())
                }
            },
        )?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
