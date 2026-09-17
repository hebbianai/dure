use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard, TryLockError};

const MAX_PENDING_REPLIES: usize = 64 * 1024;

/// The short PTY I/O critical section: nonblocking writes and read/ingest vs
/// resize ordering. Whole input frames are serialized separately so readiness
/// waits never prevent provider output drainage or Host observation.
pub(super) struct PtyIo {
    writer: Box<dyn Write + Send>,
    replies: VecDeque<u8>,
}

impl PtyIo {
    pub(super) fn new(writer: Box<dyn Write + Send>) -> Self {
        Self {
            writer,
            replies: VecDeque::new(),
        }
    }

    pub(super) fn write_input(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writer.write(bytes)
    }

    pub(super) fn has_replies(&self) -> bool {
        !self.replies.is_empty()
    }

    pub(super) fn enqueue_replies(&mut self, bytes: &[u8]) -> bool {
        if self.replies.len().saturating_add(bytes.len()) > MAX_PENDING_REPLIES {
            return false;
        }
        self.replies.extend(bytes);
        true
    }

    /// Called only with whole-frame serialization ownership. Never waits for
    /// POLLOUT: the output reader must be able to drain a query burst even when
    /// the provider will not read any answers until it finishes writing.
    pub(super) fn flush_replies(&mut self) -> io::Result<bool> {
        while !self.replies.is_empty() {
            let (first, _) = self.replies.as_slices();
            match self.writer.write(first) {
                Ok(0) => {
                    self.replies.clear();
                    return Err(io::ErrorKind::WriteZero.into());
                }
                Ok(count) if count <= first.len() => {
                    self.replies.drain(..count);
                }
                Ok(_) => {
                    self.replies.clear();
                    return Err(io::ErrorKind::InvalidData.into());
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    return Ok(false);
                }
                Err(error) => {
                    self.replies.clear();
                    return Err(error);
                }
            }
        }
        Ok(true)
    }
}

pub(super) fn try_lock_input(mutex: &Mutex<()>) -> Option<MutexGuard<'_, ()>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::WouldBlock) => None,
        Err(TryLockError::Poisoned(poisoned)) => {
            mutex.clear_poison();
            super::runtime_log(
                "recovering state-free PTY input serialization after worker failure",
            );
            Some(poisoned.into_inner())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    struct BudgetWriter {
        budget: Arc<AtomicUsize>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for BudgetWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let count = bytes.len().min(self.budget.load(Ordering::Acquire));
            if count == 0 {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            self.budget.fetch_sub(count, Ordering::AcqRel);
            self.written
                .lock()
                .unwrap()
                .extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn replies_keep_their_unwritten_suffix_and_precede_later_input() {
        let budget = Arc::new(AtomicUsize::new(3));
        let written = Arc::new(Mutex::new(Vec::new()));
        let mut io = PtyIo::new(Box::new(BudgetWriter {
            budget: budget.clone(),
            written: written.clone(),
        }));
        assert!(io.enqueue_replies(b"reply-one"));
        assert!(!io.flush_replies().unwrap());
        assert_eq!(*written.lock().unwrap(), b"rep");
        assert!(io.has_replies());
        assert!(io.enqueue_replies(b"reply-two"));
        budget.store(100, Ordering::Release);
        assert!(io.flush_replies().unwrap());
        assert!(!io.has_replies());
        io.write_input(b"user").unwrap();
        assert_eq!(*written.lock().unwrap(), b"reply-onereply-twouser");
    }

    #[test]
    fn pending_reply_budget_refuses_a_whole_batch_without_losing_prior_replies() {
        let budget = Arc::new(AtomicUsize::new(0));
        let written = Arc::new(Mutex::new(Vec::new()));
        let mut io = PtyIo::new(Box::new(BudgetWriter {
            budget: budget.clone(),
            written: written.clone(),
        }));
        let first = vec![b'x'; MAX_PENDING_REPLIES];
        assert!(io.enqueue_replies(&first));
        assert!(!io.enqueue_replies(b"overflow"));
        assert!(!io.flush_replies().unwrap());
        budget.store(MAX_PENDING_REPLIES, Ordering::Release);
        assert!(io.flush_replies().unwrap());
        assert_eq!(*written.lock().unwrap(), first);
    }
}
