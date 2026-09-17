use super::*;
use hmux_session_protocol::browser_network_capture::{
    BrowserNetworkCapture, BrowserNetworkCaptureStatus,
};

impl BrowserResourceHost {
    pub fn network_capture_status(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
        event_boundary_observed: bool,
    ) -> Result<BrowserNetworkCaptureStatus, BrowserAdmissionError> {
        self.require_identity(resource)?;
        let page = self.page_identity(page)?;
        let target = self.target_for(&page)?;
        let mut status = self.network.capture_status(&page, target);
        status.complete &= event_boundary_observed;
        Ok(status)
    }

    pub fn start_network_capture(
        &mut self,
        permit: &BrowserActionPermit,
    ) -> Result<(), BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        self.network.start_capture(&target);
        Ok(())
    }

    pub fn stop_network_capture(
        &mut self,
        permit: &BrowserActionPermit,
        event_boundary_observed: bool,
    ) -> Result<BrowserNetworkCapture, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        let mut capture = self.network.stop_capture(&permit.page, &target);
        capture.complete &= event_boundary_observed;
        Ok(capture)
    }
}
