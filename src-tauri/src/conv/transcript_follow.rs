//! A conversation view follows the provider transcript it shows while the
//! agent writes it. The OS reports each change to the transcript's file, and
//! each change tells the view that there is more to read; the view reads it
//! through `read_provider_conversation_transcript` from where its newest
//! read ended. Nothing is read or polled here.
//!
//! The view's directory is watched rather than the file itself, so a
//! transcript the provider replaces keeps reporting its changes; changes to
//! the directory's other files are not passed on.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::Path,
    sync::{Mutex, OnceLock},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// The most transcripts the desktop follows at once. A view that goes away
/// without ending its follow (a reloaded window) leaves it behind, so the
/// oldest follow ends first when another starts.
const MAX_FOLLOWS: usize = 32;

#[derive(Default)]
struct Follows {
    next_id: u64,
    watchers: BTreeMap<u64, RecommendedWatcher>,
}

fn follows() -> &'static Mutex<Follows> {
    static FOLLOWS: OnceLock<Mutex<Follows>> = OnceLock::new();
    FOLLOWS.get_or_init(Mutex::default)
}

/// Whether a reported change touches the followed file.
fn touches(event: &notify::Event, file_name: &OsString) -> bool {
    !event.kind.is_access()
        && event
            .paths
            .iter()
            .any(|path| path.file_name() == Some(file_name.as_os_str()))
}

/// Starts following `path`: `changed` runs on the watcher's thread after
/// each change to the file. Returns the follow's id for [`unfollow`].
pub fn follow(path: &Path, changed: impl Fn() + Send + 'static) -> Result<u64, String> {
    let file_name = path
        .file_name()
        .map(OsString::from)
        .ok_or_else(|| "provider transcript path names no file".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "provider transcript path names no directory".to_string())?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        // A watcher error says nothing about the file; the view still reads
        // when its refresh cursor moves.
        if event.is_ok_and(|event| touches(&event, &file_name)) {
            changed();
        }
    })
    .map_err(|error| format!("follow provider transcript: {error}"))?;
    watcher
        .watch(directory, RecursiveMode::NonRecursive)
        .map_err(|error| format!("follow provider transcript: {error}"))?;
    let mut follows = follows()
        .lock()
        .map_err(|_| "provider transcript follows are unavailable".to_string())?;
    follows.next_id += 1;
    let id = follows.next_id;
    follows.watchers.insert(id, watcher);
    while follows.watchers.len() > MAX_FOLLOWS {
        follows.watchers.pop_first();
    }
    Ok(id)
}

/// Ends a follow; an id that already ended is ignored.
pub fn unfollow(id: u64) {
    // Dropping the watcher outside the lock: it joins its thread.
    let watcher = follows()
        .lock()
        .ok()
        .and_then(|mut follows| follows.watchers.remove(&id));
    drop(watcher);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn changed_within(receiver: &mpsc::Receiver<()>, timeout: Duration) -> bool {
        receiver.recv_timeout(timeout).is_ok()
    }

    fn drain(receiver: &mpsc::Receiver<()>) {
        let quiet = Instant::now() + Duration::from_millis(500);
        while Instant::now() < quiet {
            let _ = receiver.recv_timeout(Duration::from_millis(50));
        }
    }

    #[test]
    fn an_append_to_the_followed_file_is_reported_and_its_neighbours_are_not() {
        let directory = tempfile::tempdir().unwrap();
        let directory = std::fs::canonicalize(directory.path()).unwrap();
        let path = directory.join("conversation.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let id = follow(&path, move || {
            let _ = sender.send(());
        })
        .unwrap();
        // Some backends report the watch's own setup; start from quiet.
        drain(&receiver);

        std::fs::write(directory.join("other.jsonl"), "{}\n").unwrap();
        assert!(
            !changed_within(&receiver, Duration::from_millis(700)),
            "a neighbour's change is not the transcript's"
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{}}").unwrap();
        file.sync_all().unwrap();
        assert!(changed_within(&receiver, Duration::from_secs(5)));

        unfollow(id);
        drain(&receiver);
        writeln!(file, "{{}}").unwrap();
        file.sync_all().unwrap();
        assert!(
            !changed_within(&receiver, Duration::from_millis(700)),
            "an ended follow reports nothing"
        );
        unfollow(id);
    }
}
