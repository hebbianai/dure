use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use std::{future::Future, pin::Pin};
use tokio::time::Duration;
mod connection;
mod frame;
mod objects;
mod socket;
use connection::Connection;
pub(in crate::browser_engine) use frame::{FrameRenderer, FrameScope};
pub(super) use objects::BrowserObjectGroup;
use objects::ObjectGroups;

/// Clones borrow one resource-owned command connection. A temporary observer
/// must not detach a page: Chromium detachment can clear another session's
/// media override. Sessions are cached by exact target and live until page close.
#[derive(Clone)]
pub(super) struct BrowserCdp {
    connection: Arc<Connection>,
    objects: Arc<ObjectGroups>,
    deadline: Option<Arc<Deadline>>,
    frame: Option<FrameScope>,
}

type Deadline =
    dyn Fn(Duration) -> Pin<Box<dyn Future<Output = &'static str> + Send>> + Send + Sync;

impl BrowserCdp {
    pub(super) async fn connect(address: &str) -> Result<Self, &'static str> {
        let connection = Arc::new(Connection::connect(address).await?);
        Ok(Self {
            objects: Arc::new(ObjectGroups::start(Arc::clone(&connection))),
            connection,
            deadline: None,
            frame: None,
        })
    }

    /// An admitted page operation supplies its clock; the transport retains
    /// the same request/response bounds and has no page lifecycle authority.
    pub(super) fn with_deadline<F, Fut>(mut self, deadline: F) -> Self
    where
        F: Fn(Duration) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = &'static str> + Send + 'static,
    {
        self.deadline = Some(Arc::new(move |budget| Box::pin(deadline(budget))));
        self
    }

    pub(super) fn object_group(&self, session: &str) -> Result<BrowserObjectGroup, &'static str> {
        let id = self
            .objects
            .next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "browser_object_group_exhausted")?;
        Ok(BrowserObjectGroup {
            owner: Arc::clone(&self.objects),
            session: session.to_owned(),
            name: format!("dure-locator-{id}"),
            deadline: self.deadline.clone(),
        })
    }

    pub(super) async fn request(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, &'static str> {
        self.request_with_deadline(method, params, session, Duration::from_secs(5))
            .await
    }

    pub(super) async fn request_with_deadline(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
        budget: Duration,
    ) -> Result<Value, &'static str> {
        self.objects.check()?;
        self.connection
            .request_until(method, params, session, self.deadline(budget))
            .await
    }

    pub(super) fn deadline(
        &self,
        budget: Duration,
    ) -> Pin<Box<dyn Future<Output = &'static str> + Send>> {
        let deadline = match &self.deadline {
            Some(deadline) => deadline(budget),
            None => Box::pin(async move {
                tokio::time::sleep(budget).await;
                "browser_cdp_response_timeout"
            }) as Pin<Box<dyn Future<Output = &'static str> + Send>>,
        };
        let Some(scope) = &self.frame else {
            return deadline;
        };
        let mut lifetime = scope.lifetime.clone();
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = lifetime.changed() => "browser_frame_context_changed",
                code = deadline => code,
            }
        })
    }

    /// Event mirrors are released on the owned cleanup worker. It never runs
    /// getters and cannot block the retained dialog/event consumer.
    pub(super) fn release_objects<F, Fut>(
        &self,
        session: String,
        ids: Vec<String>,
        context_closed: impl Future<Output = ()> + Send + 'static,
        reconcile_after_error: F,
    ) -> Result<(), &'static str>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<bool, &'static str>> + Send,
    {
        if ids.is_empty() {
            return Ok(());
        }
        let connection = Arc::clone(&self.connection);
        let deadline = self.deadline.clone();
        let bytes = session.len() + ids.iter().map(String::len).sum::<usize>();
        self.objects.enqueue(bytes, async move {
            let release = async {
                for id in ids {
                    let expired: Pin<Box<dyn Future<Output = &'static str> + Send>> =
                        match &deadline {
                            Some(deadline) => deadline(Duration::from_secs(5)),
                            None => Box::pin(async {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                "browser_cdp_response_timeout"
                            }),
                        };
                    let result = connection
                        .request_until(
                            "Runtime.releaseObject",
                            json!({"objectId":id}),
                            Some(&session),
                            expired,
                        )
                        .await;
                    if let Err(code) = result {
                        if !reconcile_after_error().await? {
                            return Ok(());
                        }
                        return Err(code);
                    }
                }
                Ok(())
            };
            tokio::select! {
                biased;
                _ = context_closed => Ok(()),
                result = release => result,
            }
        })
    }

    pub(super) async fn attach(&mut self, target: &str) -> Result<String, &'static str> {
        if let Some(scope) = &self.frame {
            if scope.target != target || scope.lifetime.has_changed().is_err() {
                return Err("browser_frame_context_changed");
            }
            return Ok(scope.session.clone());
        }
        self.connection.attach(target).await
    }

    /// Built-in observers share an isolated world so page-defined getters and
    /// prototype replacements cannot execute during a read-only operation.
    pub(super) async fn isolated_context(&mut self, session: &str) -> Result<i64, &'static str> {
        let frame = self.frame_id(session).await?;
        let world = self
            .request(
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":"dure-browser-observer"}),
                Some(session),
            )
            .await?;
        world["executionContextId"]
            .as_i64()
            .ok_or("browser_context_missing")
    }

    pub(super) async fn retain_events(&mut self) {
        self.connection.retain_events();
    }
    pub(super) async fn pop_event(&mut self) -> Option<Value> {
        self.connection.pop_event()
    }
    pub(super) async fn next_event(&mut self) -> Result<Value, &'static str> {
        self.connection.next_event().await
    }

    pub(super) async fn retain_targets(&self, targets: &[&str]) {
        self.connection.retain_targets(targets).await;
    }

    pub(super) async fn retire(&self) {
        self.objects.retire().await;
        self.connection.retire().await;
    }

    /// Capture on the session that owns emulation. Screenshots and native DOM
    /// snapshots admit bulk responses; ordinary commands retain two MiB.
    pub(super) async fn capture_screenshot(
        &mut self,
        params: Value,
        session: &str,
    ) -> Result<Value, &'static str> {
        self.connection.capture_screenshot(params, session).await
    }

    pub(super) async fn print_pdf(&mut self, session: &str) -> Result<Value, &'static str> {
        self.request_with_deadline("Page.printToPDF",json!({"printBackground":true,"preferCSSPageSize":true,"transferMode":"ReturnAsStream"}),Some(session),Duration::from_secs(30)).await
    }

    pub(super) async fn capture_frame(&self, session: &str) -> Result<Value, &'static str> {
        self.connection.capture_frame(session).await
    }

    pub(super) async fn document(&mut self, session: &str) -> Result<String, &'static str> {
        let result = self
            .request("Page.getFrameTree", json!({}), Some(session))
            .await?;
        result["frameTree"]["frame"]["loaderId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(String::from)
            .ok_or("browser_document_missing")
    }
}
