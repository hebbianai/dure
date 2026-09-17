//! Exact native target ownership through initial observation and final retirement.
use super::*;

pub(super) struct TargetReservation {
    pub(super) label: Option<BrowserPageLabel>,
    pub(super) instance: BrowserInstanceId,
    pub(super) kind: ReservationKind,
}

pub(super) enum ReservationKind {
    Page,
    Replacement(Option<BrowserDocumentId>),
    Retiring,
}

impl TargetReservation {
    pub(super) fn is_retiring(&self) -> bool {
        matches!(self.kind, ReservationKind::Retiring)
    }
}

impl BrowserResourceHost {
    pub(super) fn live_page_capacity(&self) -> usize {
        self.pages.len()
            + self
                .reserved_targets
                .values()
                .filter(|owner| matches!(owner.kind, ReservationKind::Page))
                .count()
    }
    /// The process owner calls this only for an exact target it created or an
    /// owned launch target. Discovery alone cannot grant a resource ownership.
    pub fn reserve_page_target(
        &mut self,
        resource: &BrowserResourceIdentity,
        instance: BrowserInstanceId,
        target: BrowserTargetId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        self.require_ready()?;
        self.require_instance_registration(&instance)?;
        if self.owns_page_target(&target) || self.live_page_capacity() >= MAX_LIVE_PAGES {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        let revision = advance(self.revision)?;
        self.instances
            .insert(instance.clone(), instances::InstanceState::Active);
        self.reserved_targets.insert(
            target,
            TargetReservation {
                label: None,
                instance,
                kind: ReservationKind::Page,
            },
        );
        self.revision = revision;
        Ok(())
    }

    pub fn owns_page_target(&self, target: &BrowserTargetId) -> bool {
        self.reserved_targets.contains_key(target)
            || self.pages.values().any(|page| &page.target == target)
    }

    /// Retiring targets remain owned for cleanup but cannot bind another page.
    /// Their instance and resource lifetimes also fence pending observation.
    pub fn page_target_is_retiring(&self, target: &BrowserTargetId) -> bool {
        self.instance_for_target(target).is_some_and(|instance| {
            matches!(
                self.phase.projection(),
                BrowserResourcePhase::Retiring | BrowserResourcePhase::Closed
            ) || self.instances.get(instance) == Some(&instances::InstanceState::Retiring)
                || self
                    .reserved_targets
                    .get(target)
                    .is_some_and(TargetReservation::is_retiring)
        })
    }

    pub fn owned_page_targets(&self) -> BTreeSet<BrowserTargetId> {
        self.reserved_targets
            .keys()
            .cloned()
            .chain(self.pages.values().map(|page| page.target.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> BrowserResourceHost {
        BrowserResourceHost::new(BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("resource").unwrap(),
            generation: BrowserResourceGeneration::new("generation").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
        })
    }

    #[test]
    fn page_reservations_bind_once_and_share_the_live_page_capacity() {
        let mut host = host();
        let resource = host.projection().resource;
        for i in 0..MAX_LIVE_PAGES {
            host.reserve_page_target(
                &resource,
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new(format!("target:{i}")).unwrap(),
            )
            .unwrap();
        }
        let target = BrowserTargetId::new("target:0").unwrap();
        assert!(host.pages().is_empty());
        assert!(host.owns_page_target(&target));
        assert_eq!(
            host.reserve_page_target(
                &resource,
                BrowserInstanceId::new("instance").unwrap(),
                target.clone()
            ),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        let page = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                target.clone(),
                BrowserDocumentId::new("document").unwrap(),
            )
            .unwrap();
        assert_eq!(host.owned_page_targets().len(), MAX_LIVE_PAGES);
        assert_eq!(
            host.register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("overflow").unwrap(),
                BrowserDocumentId::new("doc").unwrap()
            ),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        host.page_closed(&page.page_id).unwrap();
        assert!(!host.owns_page_target(&target));
        host.reserve_page_target(
            &resource,
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("replacement").unwrap(),
        )
        .unwrap();
        host.reconcile_instance_pages(
            &BrowserInstanceId::new("instance").unwrap(),
            &BTreeSet::new(),
            Instant::now(),
        )
        .unwrap();
        assert!(host.owned_page_targets().is_empty());
    }

    #[test]
    fn page_reservations_reject_wrong_generations_and_retirement() {
        let mut host = host();
        let resource = host.projection().resource;
        let target = BrowserTargetId::new("target").unwrap();
        let mut wrong = resource.clone();
        wrong.generation = BrowserResourceGeneration::new("other").unwrap();
        assert_eq!(
            host.reserve_page_target(
                &wrong,
                BrowserInstanceId::new("instance").unwrap(),
                target.clone()
            ),
            Err(BrowserAdmissionError::ResourceMismatch)
        );
        host.reserve_page_target(
            &resource,
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
        )
        .unwrap();
        host.begin_retirement(&resource).unwrap();
        assert_eq!(
            host.reserve_page_target(
                &resource,
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("late").unwrap()
            ),
            Err(BrowserAdmissionError::ResourceRetiring)
        );
        host.engine_exited(&resource).unwrap();
        assert!(host.owned_page_targets().is_empty());
    }

    #[test]
    fn target_retirement_includes_its_instance_and_resource_lifetime() {
        let mut host = host();
        let resource = host.projection().resource;
        let instances = [
            BrowserInstanceId::new("instance:a").unwrap(),
            BrowserInstanceId::new("instance:b").unwrap(),
        ];
        let mut targets = Vec::new();
        for (index, instance) in instances.iter().enumerate() {
            let published = BrowserTargetId::new(format!("published:{index}")).unwrap();
            host.register_page(
                instance.clone(),
                published.clone(),
                BrowserDocumentId::new(format!("document:{index}")).unwrap(),
            )
            .unwrap();
            let reserved = BrowserTargetId::new(format!("reserved:{index}")).unwrap();
            host.reserve_page_target(&resource, instance.clone(), reserved.clone())
                .unwrap();
            targets.push([published, reserved]);
        }
        let pages = host.pages();
        assert!(
            targets
                .iter()
                .flatten()
                .all(|target| !host.page_target_is_retiring(target))
        );
        host.begin_instance_retirement(&resource, &instances[0])
            .unwrap();
        assert!(
            targets[0]
                .iter()
                .all(|target| host.page_target_is_retiring(target))
        );
        assert!(
            targets[1]
                .iter()
                .all(|target| !host.page_target_is_retiring(target))
        );
        host.begin_retirement(&resource).unwrap();
        assert!(
            targets
                .iter()
                .flatten()
                .all(|target| host.page_target_is_retiring(target))
        );
        assert!(!host.page_target_is_retiring(&BrowserTargetId::new("unowned").unwrap()));
        assert_eq!(
            host.pages(),
            pages,
            "Retirement fences observation without losing cleanup handles"
        );
        host.engine_exited(&resource).unwrap();
        assert!(host.owned_page_targets().is_empty());
    }
}
