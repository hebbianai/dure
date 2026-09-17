use super::*;
use hmux_session_protocol::browser_interception::*;

#[derive(Default)]
pub(super) struct PageInterception {
    rules: Vec<BrowserRequestRule>,
    applied: bool,
}

impl BrowserResourceHost {
    pub fn interception_status(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
        observed: bool,
    ) -> Result<BrowserInterceptionStatus, BrowserAdmissionError> {
        self.require_identity(resource)?;
        let identity = self.page_identity(page)?;
        let state = &self
            .pages
            .get(page)
            .ok_or(BrowserAdmissionError::PageGone)?
            .interception;
        let network = self.network_snapshot(&identity, Instant::now())?;
        Ok(BrowserInterceptionStatus {
            page: identity,
            enabled: !state.rules.is_empty(),
            available: observed && network.complete && (state.rules.is_empty() || state.applied),
            rules: state.rules.clone(),
            requests: network.requests,
            history_truncated: network.history_truncated,
        })
    }

    /// Configuration belongs to the page lifetime, including later documents
    /// and controllers. The adapter confirms projection on all current sources.
    pub fn configure_interception(
        &mut self,
        permit: &BrowserActionPermit,
        action: &BrowserInterceptionAction,
    ) -> Result<BrowserTargetId, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        self.configure_page_interception(&permit.page.page_id, action)?;
        Ok(target)
    }

    /// Only the active operation's accounted new page can borrow its source
    /// permit. This does not confer authority over an arbitrary neighbor tab.
    pub fn configure_created_page_interception(
        &mut self,
        permit: &BrowserActionPermit,
        action: &BrowserInterceptionAction,
    ) -> Result<BrowserTargetId, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        let target = self.created_page_target(permit)?.clone();
        let page = self
            .page_for_target(&target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        self.configure_page_interception(&page.page_id, action)?;
        Ok(target)
    }

    fn configure_page_interception(
        &mut self,
        page: &BrowserPageId,
        action: &BrowserInterceptionAction,
    ) -> Result<(), BrowserAdmissionError> {
        if let BrowserInterceptionAction::Enable { rule } = action {
            let rules = self
                .pages
                .values()
                .flat_map(|page| &page.interception.rules);
            let bytes = rules
                .clone()
                .chain(std::iter::once(rule))
                .try_fold(0usize, |total, rule| {
                    serde_json::to_vec(rule).map(|value| total + value.len())
                })
                .map_err(|_| BrowserAdmissionError::CapacityExceeded)?;
            let page_rules = &self
                .pages
                .get(page)
                .ok_or(BrowserAdmissionError::PageGone)?
                .interception
                .rules;
            if bytes > 512 * 1024
                || page_rules
                    .iter()
                    .map(|rule| rule.patterns().len())
                    .sum::<usize>()
                    + rule.patterns().len()
                    > 32
            {
                return Err(BrowserAdmissionError::CapacityExceeded);
            }
        }
        let state = &mut self
            .pages
            .get_mut(page)
            .ok_or(BrowserAdmissionError::PageGone)?
            .interception;
        match action {
            BrowserInterceptionAction::Enable { rule } => state.rules.push(rule.clone()),
            BrowserInterceptionAction::Remove { pattern } => {
                state.rules = std::mem::take(&mut state.rules)
                    .into_iter()
                    .filter_map(|rule| rule.excluding_pattern(pattern))
                    .collect();
            }
            BrowserInterceptionAction::Disable => state.rules.clear(),
        }
        state.applied = false;
        Ok(())
    }

    pub fn interception_enabled(&self, target: &BrowserTargetId) -> bool {
        self.pages
            .values()
            .any(|page| &page.target == target && !page.interception.rules.is_empty())
    }

    pub fn interception_applied(
        &mut self,
        target: &BrowserTargetId,
    ) -> Result<(), BrowserAdmissionError> {
        let page = self
            .pages
            .values_mut()
            .find(|page| &page.target == target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        page.interception.applied = true;
        Ok(())
    }

    /// None means an earlier matching rule needs the request's observed type.
    /// The adapter retains the native paused operation until that fact arrives.
    pub fn intercepted_request(
        &self,
        target: &BrowserTargetId,
        url: &str,
        resource_type: Option<&str>,
    ) -> Option<BrowserRequestEffect> {
        let Some(page) = self.pages.values().find(|page| &page.target == target) else {
            return Some(BrowserRequestEffect::Continue);
        };
        for rule in &page.interception.rules {
            if matches!(rule.effect(), BrowserRequestEffect::Continue) || !rule.matches_url(url) {
                continue;
            }
            if rule.matches_resource_type(resource_type)? {
                return Some(rule.effect().clone());
            }
        }
        Some(BrowserRequestEffect::Continue)
    }
}

#[cfg(test)]
mod tests;
