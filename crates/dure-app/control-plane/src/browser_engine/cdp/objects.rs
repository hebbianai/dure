//! Owned cleanup for scoped node groups and console event mirror objects.

use super::Connection;
use serde_json::json;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;

#[cfg(test)]
mod tests;

type Release = Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send>>;

#[derive(Default)]
struct Queue {
    jobs: VecDeque<(usize, Release)>,
    bytes: usize,
    failed: Option<&'static str>,
}

pub(super) struct ObjectGroups {
    pub(super) next: AtomicU64,
    queue: Arc<Mutex<Queue>>,
    changed: Arc<Notify>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
    connection: Arc<Connection>,
}

impl ObjectGroups {
    pub(super) fn start(connection: Arc<Connection>) -> Self {
        let queue = Arc::new(Mutex::new(Queue::default()));
        let changed = Arc::new(Notify::new());
        let pending = Arc::clone(&queue);
        let ready = Arc::clone(&changed);
        let owned = Arc::clone(&connection);
        let task = tokio::spawn(async move {
            loop {
                let notified = ready.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let next = {
                    let mut queue = pending.lock().expect("object release queue");
                    if queue.failed.is_some() {
                        break;
                    }
                    queue.jobs.pop_front()
                };
                let Some((bytes, mut release)) = next else {
                    notified.await;
                    continue;
                };
                let result = loop {
                    let notified = ready.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if let Some(code) = pending.lock().expect("object release queue").failed {
                        break Err(code);
                    }
                    tokio::select! {
                        result = &mut release => break result,
                        _ = notified => {},
                    }
                };
                let mut queue = pending.lock().expect("object release queue");
                queue.bytes -= bytes;
                if let Err(code) = result {
                    queue.failed = Some(code);
                    break;
                }
            }
            // A failed cleanup cannot accumulate more retained remote objects.
            // Closing this owned connection also wakes its event observer.
            {
                let mut queue = pending.lock().expect("object release queue");
                queue.jobs.clear();
                queue.bytes = 0;
            }
            owned.retire().await;
        });
        Self {
            next: AtomicU64::new(0),
            queue,
            changed,
            task: AsyncMutex::new(Some(task)),
            connection,
        }
    }

    pub(super) fn check(&self) -> Result<(), &'static str> {
        self.queue
            .lock()
            .expect("object release queue")
            .failed
            .map_or(Ok(()), Err)
    }

    pub(super) fn enqueue(
        &self,
        bytes: usize,
        release: impl Future<Output = Result<(), &'static str>> + Send + 'static,
    ) -> Result<(), &'static str> {
        let mut queue = self.queue.lock().expect("object release queue");
        if let Some(code) = queue.failed {
            return Err(code);
        }
        if queue.jobs.len() >= 4096 || bytes > (4 * 1024 * 1024_usize).saturating_sub(queue.bytes) {
            queue.failed = Some("browser_object_release_limit");
            self.changed.notify_one();
            return Err("browser_object_release_limit");
        }
        queue.bytes += bytes;
        queue.jobs.push_back((bytes, Box::pin(release)));
        self.changed.notify_one();
        Ok(())
    }

    pub(super) async fn retire(&self) {
        let mut owned_task = self.task.lock().await;
        if let Some(task) = owned_task.take() {
            task.abort();
            let _ = task.await;
        }
        let mut queue = self.queue.lock().expect("object release queue");
        queue.failed = Some("browser_cdp_retired");
        queue.jobs.clear();
        queue.bytes = 0;
    }
}

impl Drop for ObjectGroups {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

/// Dropping a node handle schedules cleanup independently of page observations
/// and dialog responses; the resource owner awaits or cancels that worker.
pub(in crate::browser_engine) struct BrowserObjectGroup {
    pub(super) owner: Arc<ObjectGroups>,
    pub(super) session: String,
    pub(super) name: String,
    pub(super) deadline: Option<Arc<super::Deadline>>,
}

impl BrowserObjectGroup {
    pub(in crate::browser_engine) fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for BrowserObjectGroup {
    fn drop(&mut self) {
        let connection = Arc::clone(&self.owner.connection);
        let session = self.session.clone();
        let group = self.name.clone();
        let deadline = self.deadline.clone();
        let bytes = session.len() + group.len();
        let _ = self.owner.enqueue(bytes, async move {
            if !connection.has_session(&session).await {
                return Ok(());
            }
            let expired: Pin<Box<dyn Future<Output = &'static str> + Send>> = match deadline {
                Some(deadline) => deadline(std::time::Duration::from_secs(5)),
                None => Box::pin(async {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    "browser_cdp_response_timeout"
                }),
            };
            connection
                .request_until(
                    "Runtime.releaseObjectGroup",
                    json!({"objectGroup":group}),
                    Some(&session),
                    expired,
                )
                .await?;
            Ok(())
        });
    }
}
