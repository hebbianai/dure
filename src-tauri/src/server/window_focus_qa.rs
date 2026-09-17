use crate::qa::{WindowFocusQa, WindowRole};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(super) fn step(
    app: &AppHandle,
    req: &mut tiny_http::Request,
) -> Result<Value, String> {
    let body = super::read_json_body(req)?;
    let (proof, role) = action_target(&body, "step")?;
    app.state::<WindowFocusQa>().step(app, &proof, role)
}

pub(super) fn scroll_rows(
    app: &AppHandle,
    req: &mut tiny_http::Request,
) -> Result<Value, String> {
    let body = super::read_json_body(req)?;
    let (proof, role) = action_target(&body, "viewport scroll")?;
    let rows = body
        .get("rows")
        .and_then(Value::as_i64)
        .and_then(|rows| i32::try_from(rows).ok())
        .ok_or_else(|| "viewport scroll rows must be a signed 32-bit integer".to_string())?;
    app.state::<WindowFocusQa>()
        .scroll_rows(app, &proof, role, rows)
}

fn action_target(body: &Value, action: &str) -> Result<(String, WindowRole), String> {
    let proof = body
        .get("proof")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{action} requires proof"))?;
    let role = serde_json::from_value::<WindowRole>(
        body.get("window")
            .cloned()
            .ok_or_else(|| format!("{action} requires window"))?,
    )
    .map_err(|_| format!("{action} window must be a or b"))?;
    Ok((proof, role))
}
