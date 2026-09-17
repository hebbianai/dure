#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalSurfaceGeometry {
    pub(crate) rows: u16,
    pub(crate) columns: u16,
}

impl TerminalSurfaceGeometry {
    pub(crate) fn fit_surfaces(self, other: Self) -> Self {
        // One PTY width must fit every attached writer. Height remains a
        // per-surface viewport over the tallest canonical screen.
        Self {
            rows: self.rows.max(other.rows),
            columns: self.columns.min(other.columns),
        }
    }
}
