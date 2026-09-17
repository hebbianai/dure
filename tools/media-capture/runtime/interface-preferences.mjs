export function captureInterfacePreferences(scenario) {
  return scenario.interfaceMode
    ? { interfaceMode: scenario.interfaceMode }
    : {};
}
