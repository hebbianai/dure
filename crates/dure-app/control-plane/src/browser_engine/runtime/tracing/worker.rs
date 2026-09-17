use super::{document::Document, *};
use tokio::time::{Duration, timeout};

pub(super) async fn run(
    connection: ChromiumConnection,
    target: BrowserTargetId,
    mode: TraceMode,
    mut requested: watch::Receiver<Finish>,
    startup: &watch::Sender<Option<Result<(), &'static str>>>,
) -> TraceResult {
    let mut result = TraceResult {
        start_sent: false,
        started: false,
        ended: false,
        stream_closed: true,
        bytes: Vec::new(),
        event_count: 0,
        data_loss: false,
        error: None,
    };
    let mut cdp = match BrowserCdp::connect(connection.endpoint()).await {
        Ok(cdp) => cdp,
        Err(code) => {
            result.error = Some(code);
            return result;
        }
    };
    cdp.retain_events().await;
    // Tracing has browser-instance scope. A page session's detachment clears
    // that page's media emulation, even if it only requested Tracing.start.
    // Keep trace cleanup on its own browser session and verify the originally
    // selected page still exists before starting the native interval.
    let attached = async {
        let page = cdp
            .request(
                "Target.getTargetInfo",
                json!({"targetId":target.as_str()}),
                None,
            )
            .await?;
        if page["targetInfo"]["targetId"] != target.as_str() || page["targetInfo"]["type"] != "page"
        {
            return Err("browser_trace_target_changed");
        }
        let browser = cdp
            .request("Target.attachToBrowserTarget", json!({}), None)
            .await?;
        browser["sessionId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or("browser_trace_session_missing")
    }
    .await;
    let session = match attached {
        Ok(session) => session,
        Err(code) => {
            result.error = Some(code);
            cdp.retire().await;
            return result;
        }
    };
    if requested.has_changed().is_err() || *requested.borrow() == Finish::Retire {
        result.error = Some("browser_trace_retired");
        cdp.retire().await;
        return result;
    }
    result.start_sent = true;
    let started = cdp
        .request("Tracing.start", mode.parameters(), Some(&session))
        .await;
    result.started = started.is_ok();
    startup.send_replace(Some(started.as_ref().map(|_| ()).map_err(|code| *code)));
    if let Err(code) = started {
        result.error = Some(code);
        if code == "browser_cdp_request_rejected" {
            // This connection never started an interval. It cannot stop a
            // competing session that caused native admission to reject it.
            cdp.retire().await;
            return result;
        }
    }
    let mut document = Document::new(&mode);
    let mut complete = None;
    while result.error.is_none()
        && *requested.borrow() == Finish::Recording
        && requested.has_changed().is_ok()
    {
        tokio::select! {
            biased;
            _ = requested.changed() => {},
            event = cdp.next_event() => {
                match event {
                    Ok(event) => if let Err(code)=collect(event,&session,&mut document,&mut complete) {result.error=Some(code);},
                    Err(code) => result.error=Some(code),
                }
            }
        }
        if complete.is_some() {
            break;
        }
    }
    let mut handle = None;
    // Only this task sends end and consumes completion/stream events. A lost
    // response can still be reconciled by this session's tracingComplete.
    let drained = timeout(Duration::from_secs(30), async {
        if complete.is_none() {
            let ended = cdp.request("Tracing.end", json!({}), Some(&session)).await;
            if matches!(ended, Err("browser_cdp_request_rejected")) {
                return Err("browser_trace_end_rejected");
            }
            loop {
                let event = cdp.next_event().await?;
                if let Err(code) = collect(event, &session, &mut document, &mut complete) {
                    result.error.get_or_insert(code);
                }
                if complete.is_some() {
                    break;
                }
            }
        }
        let complete = complete
            .as_ref()
            .ok_or("browser_trace_completion_missing")?;
        result.ended = true;
        // Retain native cleanup authority before validating unrelated metadata.
        // A malformed completion still announces a stream that this owner closes.
        if let Some(stream) = complete.get("stream") {
            result.stream_closed = false;
            let stream = stream
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or("browser_trace_stream_invalid")?
                .to_owned();
            handle = Some(stream);
        }
        if matches!(mode, TraceMode::Trace) && handle.is_none() {
            result.stream_closed = false;
            return Err("browser_trace_stream_missing");
        }
        result.data_loss = complete["dataLossOccurred"]
            .as_bool()
            .ok_or("browser_trace_completion_invalid")?;
        if let Some(stream) = handle.as_deref() {
            if result.error.is_none()
                && *requested.borrow() != Finish::Retire
                && requested.has_changed().is_ok()
            {
                let bytes = super::super::stream::read(&mut cdp, &session, stream)
                    .await
                    .map_err(|error| match error {
                        super::super::stream::StreamError::Transport(code) => code,
                        super::super::stream::StreamError::Invalid => {
                            "browser_trace_stream_invalid"
                        }
                        super::super::stream::StreamError::Limit => "browser_trace_byte_limit",
                        super::super::stream::StreamError::Stalled => {
                            "browser_trace_stream_stalled"
                        }
                    })?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "browser_trace_stream_json_invalid")?;
                document.append(&value["traceEvents"])?;
            }
        }
        Ok::<_, &'static str>(())
    })
    .await
    .unwrap_or(Err("browser_trace_finish_timeout"));
    if let Err(code) = drained {
        result.error.get_or_insert(code);
    }
    if let Some(handle) = handle {
        result.stream_closed = cdp
            .request("IO.close", json!({"handle":handle}), Some(&session))
            .await
            .is_ok();
        if !result.stream_closed {
            result
                .error
                .get_or_insert("browser_trace_stream_close_failed");
        }
    }
    cdp.retire().await;
    result.data_loss |= document.dropped;
    if requested.has_changed().is_err() || *requested.borrow() == Finish::Retire {
        result.error.get_or_insert("browser_trace_retired");
    }
    if result.error.is_none() {
        (result.bytes, result.event_count) = document.finish();
    }
    result
}

fn collect(
    event: Value,
    session: &str,
    document: &mut Document,
    complete: &mut Option<Value>,
) -> Result<(), &'static str> {
    if event["sessionId"] != session {
        return Ok(());
    }
    match event["method"].as_str() {
        Some("Tracing.dataCollected") => document.append(&event["params"]["value"]),
        Some("Tracing.tracingComplete") => {
            *complete = Some(event["params"].clone());
            Ok(())
        }
        _ => Ok(()),
    }
}
