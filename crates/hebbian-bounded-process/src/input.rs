use crate::{CommandFailure, CommandSpec};
use std::fs::File;
use std::io::{Seek, Write};

pub(crate) fn prepare(command: &CommandSpec) -> Result<Option<File>, CommandFailure> {
    command
        .input_bytes()
        .map(|bytes| {
            // tempfile is private and removed on close; this is an execution input,
            // not durable state. Prepare it before launching any owned process.
            let mut file = tempfile::tempfile().map_err(|_| CommandFailure::StdinPrepare)?;
            file.write_all(bytes)
                .map_err(|_| CommandFailure::StdinPrepare)?;
            file.rewind().map_err(|_| CommandFailure::StdinPrepare)?;
            Ok(file)
        })
        .transpose()
}
