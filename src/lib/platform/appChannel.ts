type FrontendAppChannelEnvironment = Pick<
  ImportMetaEnv,
  "VITE_DURE_APP_CHANNEL" | "VITE_HEBBIAN_APP_CHANNEL"
>;

export function configuredFrontendAppChannel(
  environment: FrontendAppChannelEnvironment = import.meta.env,
): string | undefined {
  return (
    environment.VITE_DURE_APP_CHANNEL ??
    environment.VITE_HEBBIAN_APP_CHANNEL ??
    undefined
  );
}
