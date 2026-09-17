// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/actions.rs::handle_vitals. Dure returns the original structured
// metrics together with the readable report in its standard JSON envelope.
// License: ../environment/device/LICENSE-agent-browser.

use serde_json::{Value, json};

pub(super) fn measurement(url: &str, raw: &Value) -> Result<Value, &'static str> {
    let cwv = raw.get("cwv").cloned().unwrap_or(json!({}));
    let timing = raw
        .get("timing")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let ttfb = raw.get("ttfb").and_then(|v| v.as_f64());
    let lcp = cwv.get("lcp").cloned().unwrap_or(Value::Null);
    let cls_score = cwv.get("cls").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let cls_entries = cwv.get("clsEntries").cloned().unwrap_or(json!([]));
    let fcp = cwv.get("fcp").and_then(|v| v.as_f64());
    let inp = cwv.get("inp").and_then(|v| v.as_f64());

    let round = |n: f64| (n * 100.0).round() / 100.0;

    let mut hydration_phases: Vec<Value> = Vec::new();
    let mut hydration_start = f64::INFINITY;
    let mut hydration_end = 0.0f64;
    let mut hydrated_components: Vec<Value> = Vec::new();
    // React's profiling build emits `console.timeStamp(label, start, end,
    // track, trackGroup, color)` entries whose `track` / `trackGroup`
    // fields are literal strings containing the atom glyph (e.g.
    // "Scheduler ⚛", "Components ⚛"). The comparisons below match those
    // exact strings — don't "clean up" the glyphs.
    for e in &timing {
        let label = e.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let track = e.get("track").and_then(|v| v.as_str()).unwrap_or("");
        let track_group = e.get("trackGroup").and_then(|v| v.as_str()).unwrap_or("");
        let color = e.get("color").and_then(|v| v.as_str()).unwrap_or("");
        let start = e.get("startTime").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let end = e.get("endTime").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if end <= start {
            continue;
        }
        if track_group == "Scheduler ⚛" {
            hydration_phases.push(json!({
                "label": label,
                "startTime": round(start),
                "endTime": round(end),
                "duration": round(end - start),
            }));
            if label == "Hydrated" {
                if start < hydration_start {
                    hydration_start = start;
                }
                if end > hydration_end {
                    hydration_end = end;
                }
            }
        } else if track == "Components ⚛" && color.starts_with("tertiary") {
            hydrated_components.push(json!({
                "name": label,
                "startTime": round(start),
                "endTime": round(end),
                "duration": round(end - start),
            }));
        }
    }
    hydrated_components.sort_by(|a, b| {
        let da = a.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let db = b.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
    });

    let hydration = if hydration_start.is_finite() && hydration_end > 0.0 {
        json!({
            "startTime": round(hydration_start),
            "endTime": round(hydration_end),
            "duration": round(hydration_end - hydration_start),
        })
    } else {
        Value::Null
    };

    let mut data_value = json!({
        "url": url,
        "ttfb": ttfb,
        "lcp": lcp,
        "cls": { "score": round(cls_score), "entries": cls_entries },
        "fcp": fcp,
        "inp": inp,
        "hydration": hydration,
        "phases": hydration_phases,
        "hydratedComponents": hydrated_components,
    });

    let data =
        serde_json::from_value(data_value.clone()).map_err(|_| "browser_vitals_data_invalid")?;
    data_value["report"] = json!(super::report::format_vitals_report(&data));
    Ok(data_value)
}
