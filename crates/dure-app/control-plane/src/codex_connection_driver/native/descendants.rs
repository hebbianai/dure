//! Ordered provider thread facts, including ancestry through unloaded parents.
//! These are a projection, not permission to stop a provider process tree.

use super::lifecycle::identifier;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MAX_THREADS: usize = 4096;

#[derive(Clone, Default, Eq, PartialEq)]
enum Parent {
    #[default]
    Unknown,
    Root,
    Thread(String),
}

#[derive(Clone, Default, Eq, PartialEq)]
struct Thread {
    parent: Parent,
    // Missing or unrecognized status cannot settle a previously active child.
    idle: bool,
}

#[derive(Default)]
pub(super) struct Descendants {
    threads: HashMap<String, Thread>,
    incomplete: bool,
}

impl Descendants {
    pub(super) fn observe(&mut self, message: &Value) -> bool {
        let method = message.get("method").and_then(Value::as_str);
        let (id, parent, status) = match method {
            Some("thread/started") => {
                let Some(thread) = message.pointer("/params/thread") else {
                    return false;
                };
                let parent = match thread.get("parentThreadId") {
                    Some(Value::Null) => Some(Parent::Root),
                    Some(value) => identifier(value).map(|id| Parent::Thread(id.into())),
                    None => None,
                };
                (
                    thread.get("id").and_then(identifier),
                    parent,
                    thread.pointer("/status/type").and_then(Value::as_str),
                )
            }
            Some("thread/status/changed") => (
                message.pointer("/params/threadId").and_then(identifier),
                None,
                message
                    .pointer("/params/status/type")
                    .and_then(Value::as_str),
            ),
            Some("thread/closed") => (
                message.pointer("/params/threadId").and_then(identifier),
                None,
                Some("notLoaded"),
            ),
            _ => return false,
        };
        let Some(id) = id else { return false };
        if !self.threads.contains_key(id) && self.threads.len() == MAX_THREADS {
            let changed = !self.incomplete;
            self.incomplete = true;
            return changed;
        }
        let previous = self.threads.get(id).cloned();
        let thread = self.threads.entry(id.into()).or_default();
        if let Some(parent) = parent {
            thread.parent = parent;
        }
        match status {
            Some("idle" | "notLoaded") => thread.idle = true,
            Some(_) => thread.idle = false,
            None => {}
        }
        previous.as_ref() != Some(thread)
    }

    pub(super) fn working(&self, root: &str) -> bool {
        if self.incomplete {
            return true;
        }
        self.threads.iter().any(|(id, thread)| {
            if id == root || thread.idle {
                return false;
            }
            let mut current = id.as_str();
            let mut visited = HashSet::new();
            loop {
                if current == root {
                    return true;
                }
                if !visited.insert(current) {
                    return true;
                }
                match self.threads.get(current).map(|thread| &thread.parent) {
                    Some(Parent::Root) => return false,
                    Some(Parent::Thread(parent)) => current = parent,
                    // Out-of-order ancestry must not invent subtree idleness.
                    Some(Parent::Unknown) | None => return true,
                }
            }
        })
    }
}
