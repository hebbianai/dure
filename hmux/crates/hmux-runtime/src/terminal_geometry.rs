#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalSurfaceGeometry {
    pub(crate) rows: u16,
    pub(crate) columns: u16,
}

impl TerminalSurfaceGeometry {
    pub(crate) fn fit_surfaces(self, other: Self) -> Self {
        // Ordinary PTY width must fit every attached writer. Height remains a
        // per-surface viewport over the tallest canonical screen.
        Self {
            rows: self.rows.max(other.rows),
            columns: self.columns.min(other.columns),
        }
    }
}

/// Preferred width is an immutable, negotiated attachment role. Only applied
/// proposals participate; ordinary widths remain available when that role's
/// final attachment detaches. Height always includes every writer.
pub(crate) fn select_terminal_surface_geometry(
    proposals: impl IntoIterator<Item = (TerminalSurfaceGeometry, bool)>,
) -> Option<TerminalSurfaceGeometry> {
    let mut combined: Option<TerminalSurfaceGeometry> = None;
    let mut preferred_columns: Option<u16> = None;
    for (geometry, preferred_width) in proposals {
        combined = Some(combined.map_or(geometry, |current| current.fit_surfaces(geometry)));
        if preferred_width {
            preferred_columns = Some(
                preferred_columns.map_or(geometry.columns, |columns| columns.min(geometry.columns)),
            );
        }
    }
    combined.map(|mut geometry| {
        if let Some(columns) = preferred_columns {
            geometry.columns = columns;
        }
        geometry
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_width_changes_only_width_selection() {
        let desktop = TerminalSurfaceGeometry {
            columns: 38,
            rows: 50,
        };
        let phone = TerminalSurfaceGeometry {
            columns: 53,
            rows: 42,
        };
        let second_phone = TerminalSurfaceGeometry {
            columns: 45,
            rows: 20,
        };
        assert_eq!(select_terminal_surface_geometry([]), None);
        assert_eq!(
            select_terminal_surface_geometry([(desktop, false), (phone, false)]),
            Some(desktop)
        );
        assert_eq!(
            select_terminal_surface_geometry([(desktop, false), (phone, true)]),
            Some(TerminalSurfaceGeometry {
                columns: 53,
                rows: 50
            })
        );
        assert_eq!(
            select_terminal_surface_geometry([
                (desktop, false),
                (phone, true),
                (second_phone, true)
            ]),
            Some(TerminalSurfaceGeometry {
                columns: 45,
                rows: 50
            })
        );
        assert_eq!(
            select_terminal_surface_geometry([(desktop, false)]),
            Some(desktop)
        );
    }
}
