use super::Inbound;
use std::fmt;
use std::io;
use std::time::Instant;

/// Command outcome observed after the SSH channel closes, not at stdout EOF.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelCompletion {
    pub exit_status: Option<u32>,
    pub diagnostic: String,
}

impl ChannelCompletion {
    pub(crate) fn failure_detail(&self) -> Option<String> {
        match self.exit_status {
            Some(0) => None,
            None if self.diagnostic.is_empty() => None,
            _ => Some(self.to_string()),
        }
    }
}

impl fmt::Display for ChannelCompletion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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
