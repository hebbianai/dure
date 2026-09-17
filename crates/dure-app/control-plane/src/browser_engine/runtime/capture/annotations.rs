use super::*;
use crate::browser_engine::runtime::{BrowserSnapshotOptions, locator::LocatedElement, snapshot};
use hmux_session_protocol::browser_resource::BrowserElementId;
use std::collections::BTreeSet;

pub(super) async fn observe(
    mut cdp: BrowserCdp,
    target: &str,
    area: [f64; 4],
    scroll: [f64; 2],
    selection: Option<&Value>,
) -> Result<(Vec<Value>, BTreeSet<BrowserElementId>), BrowserRuntimeError> {
    let options: BrowserSnapshotOptions =
        serde_json::from_value(json!({"interactive":true})).expect("fixed snapshot options");
    let (data, elements) = snapshot::observe(&mut cdp, target, "", &options, None).await?;
    let mut annotations = Vec::new();
    for element in &elements {
        let backend = element
            .as_str()
            .strip_prefix('e')
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or("browser_element_invalid")?;
        let rect = async {
            let mut element = LocatedElement::resolve_node(cdp.clone(), target, backend).await?;
            if element
                .call("function(){return this.isConnected && this.getClientRects().length > 0;}")
                .await?
                != true
            {
                return Err("browser_element_not_visible");
            }
            element.page_box().await
        }
        .await;
        let rect = match rect {
            Ok(rect) => rect,
            Err("browser_element_not_visible" | "browser_element_changed") => continue,
            Err(code) => return Err(code.into()),
        };
        let x = rect["x"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?
            + scroll[0]
            - area[0];
        let y = rect["y"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?
            + scroll[1]
            - area[1];
        let width = rect["width"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?;
        let height = rect["height"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?;
        if x >= area[2] || y >= area[3] || x + width <= 0.0 || y + height <= 0.0 {
            continue;
        }
        if let Some(selection) = selection {
            let selected_x = selection["x"]
                .as_f64()
                .ok_or("browser_capture_dimensions_invalid")?
                + scroll[0]
                - area[0];
            let selected_y = selection["y"]
                .as_f64()
                .ok_or("browser_capture_dimensions_invalid")?
                + scroll[1]
                - area[1];
            let selected_width = selection["width"]
                .as_f64()
                .ok_or("browser_capture_dimensions_invalid")?;
            let selected_height = selection["height"]
                .as_f64()
                .ok_or("browser_capture_dimensions_invalid")?;
            if x >= selected_x + selected_width
                || y >= selected_y + selected_height
                || x + width <= selected_x
                || y + height <= selected_y
            {
                continue;
            }
        }
        let description = &data["refs"][element.as_str()];
        annotations.push(json!({"element":element,"number":annotations.len()+1,"role":description["role"],"name":description["name"],"box":{"x":x,"y":y,"width":width,"height":height}}));
    }
    Ok((annotations, elements))
}

/// Image composition uses only built-in isolated-world objects. It never adds
/// DOM nodes, calls page code, changes viewport emulation or grants input.
pub(super) async fn render(
    cdp: &mut BrowserCdp,
    session: &str,
    context: i64,
    bytes: &[u8],
    annotations: &[Value],
    scale: f64,
    options: &ImageCapture,
) -> Result<Vec<u8>, BrowserRuntimeError> {
    let group = cdp.object_group(session)?;
    // Allocate the carrier synchronously before starting asynchronous decoding.
    // Cancellation may release its group while decoding finishes, but cannot
    // leave a new remote object allocated by a later awaitPromise response.
    let carrier = cdp.request("Runtime.evaluate", json!({"expression":"({})","contextId":context,"returnByValue":false,"objectGroup":group.name()}), Some(session)).await?;
    let object = carrier["result"]["objectId"]
        .as_str()
        .ok_or("browser_capture_annotation_failed")?;
    let input = json!({"base64":STANDARD.encode(bytes),"annotations":annotations,"scale":scale,"format":options.format,"quality":options.quality.unwrap_or(90)});
    let length = cdp.request("Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":include_str!("annotations.js"),"arguments":[{"value":input}],"awaitPromise":true,"returnByValue":true,"objectGroup":group.name()}), Some(session)).await?;
    if length.get("exceptionDetails").is_some()
        || length["result"]["value"] == "browser_capture_annotation_failed"
    {
        return Err("browser_capture_annotation_failed".into());
    }
    let length = length["result"]["value"]
        .as_u64()
        .filter(|length| *length > 0 && *length <= MAX_ARTIFACT_BYTES as u64)
        .ok_or("browser_capture_byte_limit")? as usize;
    let mut bytes = Vec::with_capacity(length);
    // Keep ordinary CDP replies below their existing two-MiB control budget.
    for offset in (0..length).step_by(192 * 1024) {
        let end = (offset + 192 * 1024).min(length);
        let chunk = cdp.request("Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":"function(start,end){let value='';for(let i=start;i<end;i+=8192)value+=String.fromCharCode(...this.bytes.subarray(i,Math.min(i+8192,end)));return btoa(value);}","arguments":[{"value":offset},{"value":end}],"returnByValue":true,"objectGroup":group.name()}), Some(session)).await?;
        let chunk = STANDARD
            .decode(
                chunk["result"]["value"]
                    .as_str()
                    .ok_or("browser_capture_invalid")?,
            )
            .map_err(|_| "browser_capture_invalid")?;
        if chunk.len() != end - offset {
            return Err("browser_capture_invalid".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
