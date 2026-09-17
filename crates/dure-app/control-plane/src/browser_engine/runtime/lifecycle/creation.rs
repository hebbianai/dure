//! Shared construction settles within the originating resource lifetime.
use super::*;
use hmux_host::browser_resource::creation::BrowserPageCreationPermit;
mod init_scripts;
pub(crate) use init_scripts::{BrowserLaunchFeature, BrowserLaunchScripts};
mod owned;
mod shared;
mod slot;
pub(in crate::browser_engine::runtime) use slot::BindingSlot;
pub(crate) use slot::{BrowserInitialization, BrowserProfileSource};

impl BrowserRuntime {
    pub async fn launch(
        identity: BrowserResourceIdentity,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
    ) -> Result<Self, BrowserRuntimeError> {
        Self::launch_selected(identity, config, directory, None).await
    }

    pub async fn launch_profile(
        identity: BrowserResourceIdentity,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: &dure_app::BrowserProfileSpecV1,
    ) -> Result<Self, BrowserRuntimeError> {
        Self::launch_selected(identity, config, directory, Some(profile.clone())).await
    }

    async fn launch_selected(
        identity: BrowserResourceIdentity,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: Option<dure_app::BrowserProfileSpecV1>,
    ) -> Result<Self, BrowserRuntimeError> {
        let config = config.clone();
        let directory = directory.to_owned();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            if sender.is_closed() {
                return;
            }
            let result = Self::launch_owned(identity, &config, &directory, profile.as_ref()).await;
            if let Err(Ok(runtime)) = sender.send(result) {
                let identity = runtime.control().await.resource;
                let _ = runtime.close(&identity).await;
            }
        });
        receiver
            .await
            .map_err(|_| BrowserEngineError::after("browser_resource_creation_interrupted"))?
    }

    async fn launch_owned(
        identity: BrowserResourceIdentity,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
    ) -> Result<Self, BrowserRuntimeError> {
        let runtime = Self::new(identity, directory);
        runtime.initialize(config, profile).await?;
        Ok(runtime)
    }

    pub(crate) fn new(identity: BrowserResourceIdentity, directory: &Path) -> Self {
        let host = Arc::new(Mutex::new(BrowserResourceHost::new(identity)));
        let uploads = Arc::new(Mutex::new(upload::BrowserUploads::new(directory)));
        Self {
            host,
            uploads,
            directory: directory.to_owned(),
            changed: Arc::new(tokio::sync::Notify::new()),
            bindings: Arc::new(BindingMutex::new(BTreeMap::new())),
        }
    }

    /// The caller retains this resource before the first native child starts.
    pub(crate) async fn initialize(
        &self,
        config: &NativeBrowserEngineConfig,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
    ) -> Result<(), BrowserRuntimeError> {
        self.finish_initialization(
            self.admit_owned_binding(config, profile).await,
            Default::default(),
        )
        .await
    }

    pub(crate) async fn finish_initialization(
        &self,
        admitted: Result<BrowserInitialization, BrowserRuntimeError>,
        init_scripts: BrowserLaunchScripts,
    ) -> Result<(), BrowserRuntimeError> {
        let identity = self.control().await.resource;
        let initialized = async { admitted?.wait(init_scripts).await }.await;
        if let Err(error) = initialized {
            let _ = self.close(&identity).await;
            return Err(error);
        }
        if let Err(error) = self.observe().await {
            let _ = self.close(&identity).await;
            return Err(error);
        }
        Ok(())
    }
}
