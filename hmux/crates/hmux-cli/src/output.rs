use std::error::Error;
use std::fmt;
use std::io::{self, Write};

#[derive(Debug)]
pub(crate) struct StdoutError(io::Error);

impl StdoutError {
    fn kind(&self) -> io::ErrorKind {
        self.0.kind()
    }
}

impl fmt::Display for StdoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "failed writing to stdout: {}", self.0)
    }
}

impl Error for StdoutError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

impl From<io::Error> for StdoutError {
    fn from(error: io::Error) -> Self {
        Self(error)
    }
}

pub(crate) fn write(args: fmt::Arguments<'_>) -> Result<(), StdoutError> {
    io::stdout().lock().write_fmt(args).map_err(Into::into)
}

pub(crate) fn writeln(args: fmt::Arguments<'_>) -> Result<(), StdoutError> {
    let mut stdout = io::stdout().lock();
    stdout.write_fmt(args)?;
    stdout.write_all(b"\n").map_err(Into::into)
}

pub(crate) fn write_bytes(bytes: &[u8]) -> Result<(), StdoutError> {
    io::stdout().lock().write_all(bytes).map_err(Into::into)
}

pub(crate) fn flush() -> Result<(), StdoutError> {
    io::stdout().lock().flush().map_err(Into::into)
}

pub(crate) fn is_broken_pipe(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(source) = current {
        if source
            .downcast_ref::<StdoutError>()
            .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
        {
            return true;
        }
        current = source.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Wrapped<E>(E);

    impl<E: fmt::Display> fmt::Display for Wrapped<E> {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            self.0.fmt(formatter)
        }
    }

    impl<E: Error + 'static> Error for Wrapped<E> {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn recognizes_only_stdout_broken_pipe() {
        let broken = Wrapped(StdoutError::from(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "reader closed",
        )));
        assert!(is_broken_pipe(&broken));

        let other_stdout = Wrapped(StdoutError::from(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "read only",
        )));
        assert!(!is_broken_pipe(&other_stdout));

        let other_pipe = Wrapped(io::Error::new(io::ErrorKind::BrokenPipe, "session socket"));
        assert!(!is_broken_pipe(&other_pipe));
    }
}
