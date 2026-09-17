use super::*;
use std::collections::BTreeMap;

impl BrowserResourceHost {
    /// The request boundary already parsed header names/values. The Host owns
    /// their page lifetime and the resource's retained configuration budget.
    pub fn configure_request_headers(
        &mut self,
        permit: &BrowserActionPermit,
        headers: &BTreeMap<String, String>,
    ) -> Result<BrowserTargetId, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        let bytes: usize = self
            .pages
            .iter()
            .filter(|(id, _)| *id != &permit.page.page_id)
            .flat_map(|(_, page)| &page.request_headers)
            .chain(headers)
            .map(|(name, value)| name.len() + value.len())
            .sum();
        if bytes > 512 * 1024 {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        let page = self
            .pages
            .get_mut(&permit.page.page_id)
            .ok_or(BrowserAdmissionError::PageGone)?;
        page.request_headers = headers.clone();
        Ok(target)
    }

    pub fn request_headers(&self, target: &BrowserTargetId) -> Option<&BTreeMap<String, String>> {
        self.pages
            .values()
            .find(|page| &page.target == target)
            .map(|page| &page.request_headers)
    }

    pub fn handles_http_authentication(&self, target: &BrowserTargetId) -> bool {
        self.request_headers(target).is_some_and(|headers| {
            headers.contains_key("authorization") || headers.contains_key("proxy-authorization")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (
        BrowserResourceHost,
        BrowserPageIdentity,
        BrowserControllerLease,
    ) {
        let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("headers:r").unwrap(),
            generation: BrowserResourceGeneration::new("headers:g").unwrap(),
            workspace_id: BrowserWorkspaceId::new("headers:w").unwrap(),
        });
        let page = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("target").unwrap(),
                BrowserDocumentId::new("doc").unwrap(),
            )
            .unwrap();
        let lease = host
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .unwrap()
            .controller
            .unwrap();
        (host, page, lease)
    }

    fn permit(
        host: &mut BrowserResourceHost,
        page: &BrowserPageIdentity,
        lease: &BrowserControllerLease,
    ) -> BrowserActionPermit {
        let sequence = host.projection().next_command_sequence;
        host.begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                operation_id: BrowserOperationId::new(format!("headers:{sequence}")).unwrap(),
                command_sequence: sequence,
            },
            [],
        )
        .unwrap()
    }

    #[test]
    fn request_headers_follow_the_page_and_reject_stale_document_authority() {
        let (mut host, page, lease) = setup();
        let permit = permit(&mut host, &page, &lease);
        let headers = BTreeMap::from([("authorization".into(), "Basic fixture".into())]);
        let target = host.configure_request_headers(&permit, &headers).unwrap();
        assert!(host.handles_http_authentication(&target));
        let next = host
            .document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
            .unwrap();
        assert_eq!(
            host.configure_request_headers(&permit, &BTreeMap::new())
                .unwrap_err(),
            BrowserAdmissionError::DocumentChanged
        );
        assert_eq!(host.request_headers(&target), Some(&headers));
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        assert_eq!(host.request_headers(&target), Some(&headers));
        let neighbor = BrowserTargetId::new("neighbor").unwrap();
        host.register_page(
            BrowserInstanceId::new("instance").unwrap(),
            neighbor.clone(),
            BrowserDocumentId::new("neighbor:doc").unwrap(),
        )
        .unwrap();
        assert!(!host.handles_http_authentication(&neighbor));
        host.page_closed(&next.page_id).unwrap();
        host.register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new("recreated").unwrap(),
        )
        .unwrap();
        assert_eq!(host.request_headers(&target), Some(&BTreeMap::new()));
    }

    #[test]
    fn request_headers_replacement_reset_and_close_return_configuration_budget() {
        let (mut host, page, lease) = setup();
        let headers = BTreeMap::from([("x-fixture".into(), "x".repeat(64 * 1024 - 9))]);
        for index in 0..8 {
            let page = if index == 0 {
                page.clone()
            } else {
                host.register_page(
                    BrowserInstanceId::new("instance").unwrap(),
                    BrowserTargetId::new(format!("filled:{index}")).unwrap(),
                    BrowserDocumentId::new("doc").unwrap(),
                )
                .unwrap()
            };
            let first = permit(&mut host, &page, &lease);
            host.configure_request_headers(&first, &headers).unwrap();
            host.finish_action(first, BrowserActionOutcome::Completed)
                .unwrap();
        }
        let neighbor = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("neighbor").unwrap(),
                BrowserDocumentId::new("doc").unwrap(),
            )
            .unwrap();
        let denied = permit(&mut host, &neighbor, &lease);
        let auth = BTreeMap::from([("authorization".into(), "Basic fixture".into())]);
        assert_eq!(
            host.configure_request_headers(&denied, &auth).unwrap_err(),
            BrowserAdmissionError::CapacityExceeded
        );
        host.finish_action(denied, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
        host.page_closed(&page.page_id).unwrap();
        let accepted = permit(&mut host, &neighbor, &lease);
        let target = host.configure_request_headers(&accepted, &auth).unwrap();
        host.finish_action(accepted, BrowserActionOutcome::Completed)
            .unwrap();
        let reset = permit(&mut host, &neighbor, &lease);
        host.configure_request_headers(&reset, &BTreeMap::new())
            .unwrap();
        assert!(!host.handles_http_authentication(&target));
        host.finish_action(reset, BrowserActionOutcome::Completed)
            .unwrap();
    }
}
