export function qaEnvironmentValue(environment, suffix) {
  const canonical = environment[`DURE_QA_${suffix}`];
  return canonical === undefined || canonical === ""
    ? environment[`HEBBIAN_QA_${suffix}`]
    : canonical;
}
