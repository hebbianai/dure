use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// One application-wide prompt, before any durable window-close work starts.
#[derive(Default)]
pub(crate) struct QuitConfirmation {
    pending: Arc<AtomicBool>,
}

impl QuitConfirmation {
    pub(crate) fn request(
        &self,
        show: impl FnOnce(Box<dyn FnOnce(bool) + Send>),
        quit: impl FnOnce() + Send + 'static,
    ) {
        if self.pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = self.pending.clone();
        show(Box::new(move |approved| {
            pending.store(false, Ordering::SeqCst);
            if approved {
                quit();
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cancel_has_no_exit_side_effect_and_allows_another_request() {
        let confirmation = QuitConfirmation::default();
        let exits = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let quit_exits = exits.clone();
            let mut reply = None;
            confirmation.request(|callback| reply = Some(callback), move || {
                quit_exits.fetch_add(1, Ordering::SeqCst);
            });
            assert!(reply.is_some(), "Quit must ask before requesting app exit");
            assert_eq!(exits.load(Ordering::SeqCst), 0);
            reply.unwrap()(false);
            assert_eq!(exits.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn repeated_requests_share_one_prompt_and_approval_exits_once() {
        let confirmation = QuitConfirmation::default();
        let exits = Arc::new(AtomicUsize::new(0));
        let quit_exits = exits.clone();
        let mut reply = None;
        confirmation.request(|callback| reply = Some(callback), move || {
            quit_exits.fetch_add(1, Ordering::SeqCst);
        });
        confirmation.request(|_| panic!("duplicate prompt"), || panic!("duplicate exit"));
        assert_eq!(exits.load(Ordering::SeqCst), 0);
        reply.unwrap()(true);
        assert_eq!(exits.load(Ordering::SeqCst), 1);

        // A failed durable save can leave the app open after approval. A later
        // explicit Quit must still work; approval is not a permanent bypass.
        let mut retry = None;
        confirmation.request(|callback| retry = Some(callback), || {});
        assert!(retry.is_some());
        retry.unwrap()(false);
    }
}
