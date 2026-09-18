use super::{CAPTURE_BYTES, CONTROL_BYTES, Socket};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{Duration, timeout},
};
use tokio_tungstenite::tungstenite::Message;

type Reply = Result<Value, &'static str>;

struct Pending {
    request: Option<String>,
    stream_read: bool,
    bytes: usize,
    events_left: usize,
    reply: oneshot::Sender<Reply>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    pending: BTreeMap<u64, Pending>,
    events: Option<VecDeque<(Value, usize)>>,
    event_bytes: usize,
    error: Option<&'static str>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Notify,
    observed: Notify,
}

/// One task owns the socket. Waiting for a renderer reply does not prevent
/// a dialog response from using that same connection and retained session.
pub(super) struct Wire {
    shared: Arc<Shared>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Wire {
    pub(super) fn start(socket: Socket) -> Self {
        let shared = Arc::new(Shared::default());
        let owner = Arc::clone(&shared);
        let task = tokio::spawn(async move {
            let error = run(socket, &owner).await;
            owner.fail(error);
        });
        Self {
            shared,
            task: Mutex::new(Some(task)),
        }
    }

    pub(super) async fn request(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        deadline: Duration,
        bytes: usize,
    ) -> Reply {
        self.request_until(
            method,
            params,
            session,
            async move {
                tokio::time::sleep(deadline).await;
                "browser_cdp_response_timeout"
            },
            bytes,
        )
        .await
    }

    pub(super) async fn request_until(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        expired: impl std::future::Future<Output = &'static str>,
        bytes: usize,
    ) -> Reply {
        let (reply, received) = oneshot::channel();
        let id = {
            let mut state = self.shared.state.lock().expect("CDP state");
            if let Some(error) = state.error {
                return Err(error);
            }
            if state.pending.len() >= 64 {
                return Err("browser_cdp_pending_limit");
            }
            state.next_id = state
                .next_id
                .checked_add(1)
                .ok_or("browser_cdp_request_exhausted")?;
            let id = state.next_id;
            let mut request = json!({"id":id,"method":method,"params":params});
            if let Some(session) = session {
                request["sessionId"] = session.into();
            }
            state.pending.insert(
                id,
                Pending {
                    request: Some(request.to_string()),
                    stream_read: method == "IO.read",
                    bytes,
                    events_left: 4096,
                    reply,
                },
            );
            id
        };
        let _pending = Request {
            shared: &self.shared,
            id,
        };
        self.shared.changed.notify_one();
        tokio::select! {
            biased;
            response = received => response.map_err(|_| "browser_cdp_closed")?,
            reason = expired => Err(reason),
        }
    }

    pub(super) fn retain_events(&self) {
        let mut state = self.shared.state.lock().expect("CDP state");
        state.events = Some(VecDeque::new());
        state.event_bytes = 0;
    }

    pub(super) fn pop_event(&self) -> Option<Value> {
        let mut state = self.shared.state.lock().expect("CDP state");
        let (event, bytes) = state.events.as_mut()?.pop_front()?;
        state.event_bytes -= bytes;
        Some(event)
    }

    pub(super) async fn next_event(&self) -> Reply {
        loop {
            let notified = self.shared.observed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.shared.state.lock().expect("CDP state");
                if let Some((event, bytes)) = state.events.get_or_insert_default().pop_front() {
                    state.event_bytes -= bytes;
                    return Ok(event);
                }
                if let Some(error) = state.error {
                    return Err(error);
                }
            }
            notified.await;
        }
    }

    pub(super) async fn retire(&self) {
        self.shared.fail("browser_cdp_closed");
        let task = self.task.lock().expect("CDP task").take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().expect("CDP task").take() {
            task.abort();
        }
    }
}

/// Cancellation removes the response budget synchronously before returning
/// to the caller. The task then resumes the same socket with the smaller bound.
struct Request<'a> {
    shared: &'a Shared,
    id: u64,
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.shared
            .state
            .lock()
            .expect("CDP state")
            .pending
            .remove(&self.id);
        self.shared.changed.notify_one();
    }
}

impl Shared {
    fn fail(&self, error: &'static str) {
        let mut state = self.state.lock().expect("CDP state");
        if error == "browser_cdp_closed" {
            state.error = Some(error);
        } else {
            state.error.get_or_insert(error);
        }
        for (_, pending) in std::mem::take(&mut state.pending) {
            let _ = pending.reply.send(Err(error));
        }
        state.events = None;
        state.event_bytes = 0;
        self.observed.notify_waiters();
    }

    fn received(&self, text: &str) -> Result<(), &'static str> {
        let response: Value =
            serde_json::from_str(text).map_err(|_| "browser_cdp_response_invalid")?;
        let mut state = self.state.lock().expect("CDP state");
        account_messages(&mut state, response["id"].as_u64())?;
        if let Some(pending) = response["id"]
            .as_u64()
            .and_then(|id| state.pending.remove(&id))
        {
            let result = if text.len() > pending.bytes {
                Err("browser_cdp_read_failed")
            } else if response.get("error").is_some() {
                // Preserve exact native failures. The owning consumer decides
                // whether its stream is initializing; transport never retries.
                if response["error"]["code"] == -32602
                    && response["error"]["message"] == "Invalid InterceptionId."
                {
                    Err("browser_cdp_interception_gone")
                } else if pending.stream_read
                    && response["error"]["code"] == -32000
                    && response["error"]["message"] == "Read failed"
                {
                    Err("browser_cdp_stream_read_failed")
                } else {
                    Err("browser_cdp_request_rejected")
                }
            } else {
                response
                    .get("result")
                    .cloned()
                    .ok_or("browser_cdp_result_missing")
            };
            let _ = pending.reply.send(result);
        } else {
            if text.len() > CONTROL_BYTES {
                return Err("browser_cdp_event_limit");
            }
            if response.get("method").is_some() && state.events.is_some() {
                if state.event_bytes + text.len() > 4 * 1024 * 1024
                    || state.events.as_ref().unwrap().len() >= 4096
                {
                    return Err("browser_cdp_event_limit");
                }
                state.event_bytes += text.len();
                state
                    .events
                    .as_mut()
                    .unwrap()
                    .push_back((response, text.len()));
                self.observed.notify_waiters();
            }
        }
        Ok(())
    }
}

fn account_messages(state: &mut State, reply: Option<u64>) -> Result<(), &'static str> {
    for (id, pending) in &mut state.pending {
        if reply != Some(*id) {
            pending.events_left -= 1;
            if pending.events_left == 0 {
                return Err("browser_cdp_event_limit");
            }
        }
    }
    Ok(())
}

async fn run(mut socket: Socket, shared: &Shared) -> &'static str {
    loop {
        let queued = {
            let mut state = shared.state.lock().expect("CDP state");
            state
                .pending
                .values_mut()
                .find_map(|pending| pending.request.take())
        };
        if let Some(request) = queued {
            match timeout(
                Duration::from_secs(5),
                socket.send(Message::Text(request.into())),
            )
            .await
            {
                Ok(Ok(())) => continue,
                _ => return "browser_cdp_write_failed",
            }
        }
        // Share the short synchronous read boundary with cancellation. Once
        // cancellation returns, no read can allocate against its former budget.
        let message = {
            let state = shared.state.lock().expect("CDP state");
            let bytes = state
                .pending
                .values()
                .map(|pending| pending.bytes)
                .max()
                .unwrap_or(CONTROL_BYTES)
                .min(CAPTURE_BYTES);
            socket.read_limit(bytes).socket.try_next()
        };
        match message {
            Ok(Some(Message::Text(text))) => {
                if let Err(error) = shared.received(&text) {
                    return error;
                }
            }
            Ok(Some(_)) => {
                if let Err(error) =
                    account_messages(&mut shared.state.lock().expect("CDP state"), None)
                {
                    return error;
                }
            }
            Ok(None) => {
                tokio::select! {
                    biased;
                    _ = shared.changed.notified() => {},
                    ready = socket.ready() => if ready.is_err() { return "browser_cdp_read_failed"; },
                }
            }
            Err(error) => return error,
        }
    }
}
