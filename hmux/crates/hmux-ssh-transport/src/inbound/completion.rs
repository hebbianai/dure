use super::Inbound;
use std::fmt;
use std::io;
use std::time::Instant;

/// Command outcome observed after the SSH channel closes, not at stdout EOF.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelCompletion {
    pub exit_status: Option<u32>,
    /// The channel reported `exit-signal`. Its description is in
    /// [`Self::diagnostic`], beside whatever the command wrote to stderr.
    pub signalled: bool,
    pub diagnostic: String,
}

impl ChannelCompletion {
    /// The channel closed with neither `exit-status` nor `exit-signal`.
    ///
    /// sshd sends one of the two whenever the command itself ends, so a close
    /// without either says that the SSH connection went away underneath the
    /// command — a phone that left the network, a laptop that slept — and
    /// nothing about how the command fared. Anything the command wrote to
    /// stderr is from while it was running, and reads as its failure when
    /// attached to this outcome.
    #[must_use]
    pub fn connection_lost(&self) -> bool {
        self.exit_status.is_none() && !self.signalled
    }

    /// Why a one-shot exchange failed, if it did. A frame stream asks
    /// [`Self::connection_lost`] first: for it, a lost connection is an end of
    /// stream to reconnect from rather than a failed command.
    pub(crate) fn failure_detail(&self) -> Option<String> {
        match self.exit_status {
            Some(0) => None,
            // A signal always leaves its description here, so this is a close
            // that reported nothing at all.
            None if self.diagnostic.is_empty() => None,
            _ => Some(self.to_string()),
        }
    }
}

impl fmt::Display for ChannelCompletion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.connection_lost() {
            return formatter
                .write_str("the SSH connection closed before the remote command reported an exit");
        }
        match self.exit_status {
            Some(status) => write!(formatter, "the remote command exited with status {status}")?,
            None => formatter.write_str("the remote command ended without an exit status")?,
        }
        if !self.diagnostic.is_empty() {
            write!(formatter, ": {}", self.diagnostic)?;
        }
        Ok(())
    }
}

impl Inbound {
    pub(crate) fn wait_for_completion(
        &self,
        deadline: Option<Instant>,
    ) -> io::Result<ChannelCompletion> {
        let mut state = self.lock();
        loop {
            if state.interrupted {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the Hmux SSH transport read was interrupted",
                ));
            }
            if state.ended {
                return Ok(state.completion());
            }
            state = match deadline {
                None => self.readable.wait(state).expect("inbound state lock"),
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        let message = "the SSH channel did not finish before the deadline";
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            if state.diagnostic.is_empty() {
                                message.to_owned()
                            } else {
                                format!("{message}: {}", state.diagnostic)
                            },
                        ));
                    }
                    self.readable
                        .wait_timeout(state, deadline - now)
                        .expect("inbound state lock")
                        .0
                }
            };
        }
    }
}
