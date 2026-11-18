//! Being told when a chat-owned agent's conversation changes (#592).
//!
//! While the chat is shown it holds one `AgentChatWatchV1` stream to the
//! paired computer. The computer writes a frame when the conversation changes
//! and now and then while it does not
//! (`dure_hub_protocol::agent_chat::HubAgentChatWatchEvent`); this module
//! turns those frames into the two things the chat acts on — read the page
//! again, or the watch is over — and hands them to the screen on a channel.
//! The page itself is still read with `AgentChatTimelineV1`, so nothing here
//! carries conversation text.
//!
//! # Stopping
//!
//! The reader blocks on the socket, so stopping a watch shuts the socket down
//! ([`ChatWatches::stop`]): the read fails, the reader ends, and the computer
//! notices on its next write and lets its subscription go. A watch that ends
//! on its own (the computer stopped serving it, the network dropped, the read
//! timed out) says `ended` last, and the chat keeps asking on its interval.

use crate::hub_client;
use crate::hub_conversation::{self, AgentChatTarget};
use crate::CommandError;
use dure_hub_protocol::agent_chat::{self, AgentChatWatchSignal};
use dure_hub_protocol::hello::HubRequest;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;

/// What the chat hears from its watch.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchNotice {
    /// Read the newest page again.
    Changed,
    /// The watch is over. Always the last notice.
    Ended,
}

/// The open watches, each with the socket that stops it.
#[derive(Default)]
pub struct ChatWatches {
    last: AtomicU64,
    open: Mutex<HashMap<u64, TcpStream>>,
}

impl ChatWatches {
    fn open(&self, socket: TcpStream) -> u64 {
        let id = self.last.fetch_add(1, Ordering::AcqRel) + 1;
        self.open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, socket);
        id
    }

    /// Stop a watch. False when it already ended.
    pub fn stop(&self, id: u64) -> bool {
        let socket = self.forget(id);
        socket.is_some_and(|socket| socket.shutdown(Shutdown::Both).is_ok())
    }

    fn forget(&self, id: u64) -> Option<TcpStream> {
        self.open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&id)
    }
}

/// Read a watch until it is over, telling `notify` what the chat should do.
/// `notify` returns false once nobody listens, which stops reading at once;
/// otherwise [`WatchNotice::Ended`] is the last thing it hears.
fn relay<S: Read>(stream: &mut S, notify: impl Fn(WatchNotice) -> bool) {
    while let Ok(event) = agent_chat::read_watch_event(stream) {
        match event.signal {
            AgentChatWatchSignal::Quiet => {}
            AgentChatWatchSignal::Refused => break,
            // `watching` asks for one read too, and so does a signal a later
            // computer adds: reading again is always safe.
            AgentChatWatchSignal::Watching
            | AgentChatWatchSignal::Changed
            | AgentChatWatchSignal::Unknown => {
                if !notify(WatchNotice::Changed) {
                    return;
                }
            }
        }
    }
    let _ = notify(WatchNotice::Ended);
}

/// The chat of a chat-owned agent is shown: be told when it changes. Answers
/// once the computer took the request, with the id that stops the watch.
/// Asked only where the row carries `agent_chat_watch`.
#[tauri::command]
pub async fn hub_agent_chat_watch(
    app: tauri::AppHandle,
    id: String,
    input: AgentChatTarget,
    channel: Channel<WatchNotice>,
) -> Result<u64, CommandError> {
    let request = HubRequest::AgentChatWatchV1 {
        box_id: input.box_id,
        agent_id: input.agent_id,
    };
    let handle = app.clone();
    hub_conversation::with_stream(&app, &id, move |mut stream, token| {
        hub_client::handshake_for(&mut stream, token, request)
            .map_err(|error| hub_conversation::client_error(&error))?;
        let socket = stream.sock.try_clone().map_err(|error| {
            hub_conversation::client_error(&hub_client::HubClientError::Unreachable(
                error.to_string(),
            ))
        })?;
        let watch_id = handle.state::<ChatWatches>().open(socket);
        std::thread::spawn(move || {
            relay(&mut stream, |notice| channel.send(notice).is_ok());
            handle.state::<ChatWatches>().forget(watch_id);
        });
        Ok(watch_id)
    })
    .await
}

/// The chat is no longer shown. False when the watch already ended.
#[tauri::command]
pub fn hub_agent_chat_unwatch(watches: tauri::State<'_, ChatWatches>, watch_id: u64) -> bool {
    watches.stop(watch_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::agent_chat::{
        encode_watch_event, AgentChatRefusal, HubAgentChatWatchEvent,
    };
    use std::cell::RefCell;

    fn frames(signals: &[AgentChatWatchSignal]) -> Vec<u8> {
        signals
            .iter()
            .flat_map(|signal| {
                encode_watch_event(&HubAgentChatWatchEvent::signal(*signal)).expect("encodes")
            })
            .collect()
    }

    fn heard(incoming: &[u8]) -> Vec<WatchNotice> {
        let notices = RefCell::new(Vec::new());
        relay(&mut &incoming[..], |notice| {
            notices.borrow_mut().push(notice);
            true
        });
        notices.into_inner()
    }

    #[test]
    fn quiet_frames_are_not_told_and_the_end_is() {
        use AgentChatWatchSignal::{Changed, Quiet, Watching};
        assert_eq!(
            heard(&frames(&[Watching, Quiet, Changed, Quiet, Changed])),
            [
                WatchNotice::Changed,
                WatchNotice::Changed,
                WatchNotice::Changed,
                WatchNotice::Ended
            ]
        );
    }

    #[test]
    fn a_refused_watch_ends_and_reads_no_further() {
        let mut incoming = encode_watch_event(&HubAgentChatWatchEvent::refused(
            AgentChatRefusal::Unavailable,
            "no backend",
        ))
        .expect("encodes");
        incoming.extend(frames(&[AgentChatWatchSignal::Changed]));
        assert_eq!(heard(&incoming), [WatchNotice::Ended]);
    }

    /// An older computer acks the greeting and closes: the watch just ends.
    #[test]
    fn a_closed_or_broken_stream_ends_the_watch() {
        assert_eq!(heard(&[]), [WatchNotice::Ended]);
        let mut cut = frames(&[AgentChatWatchSignal::Changed]);
        cut.truncate(cut.len() - 1);
        assert_eq!(heard(&cut), [WatchNotice::Ended]);
    }

    #[test]
    fn nobody_listening_stops_the_reader() {
        let notices = RefCell::new(Vec::new());
        let incoming = frames(&[
            AgentChatWatchSignal::Watching,
            AgentChatWatchSignal::Changed,
        ]);
        relay(&mut incoming.as_slice(), |notice| {
            notices.borrow_mut().push(notice);
            false
        });
        assert_eq!(notices.into_inner(), [WatchNotice::Changed]);
    }

    #[test]
    fn stopping_a_watch_closes_its_socket_once() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
        let phone = TcpStream::connect(listener.local_addr().expect("address")).expect("connects");
        let (mut computer, _) = listener.accept().expect("accepts");
        computer
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("timeout");
        let watches = ChatWatches::default();
        let id = watches.open(phone);
        assert!(watches.stop(id));
        assert!(!watches.stop(id), "already stopped");
        let mut buffer = [0_u8; 1];
        assert_eq!(
            computer.read(&mut buffer).expect("closed, not timed out"),
            0
        );
    }
}
