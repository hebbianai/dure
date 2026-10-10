/** SemVer precedence, ignoring build metadata; null means either value is invalid. */
export function comparePackageVersions(leftVersion, rightVersion) {
  const parse = (value) => {
    if (typeof value !== "string" || value.length > 128) return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split(".") ?? [];
    if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
    return { core: match.slice(1, 4).map(BigInt), prerelease };
  };
  const left = parse(leftVersion);
  const right = parse(rightVersion);
  if (!left || !right) return null;
  const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;
  let order = 0;
  for (let i = 0; i < 3 && order === 0; i++) order = compare(left.core[i], right.core[i]);
  const a = left.prerelease;
  const b = right.prerelease;
  if (order === 0 && (a.length === 0 || b.length === 0)) order = compare(a.length === 0, b.length === 0);
  for (let i = 0; order === 0 && i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined || b[i] === undefined) { order = compare(a.length, b.length); break; }
    const numericA = /^\d+$/.test(a[i]);
    const numericB = /^\d+$/.test(b[i]);
    order = numericA && numericB ? compare(BigInt(a[i]), BigInt(b[i]))
      : numericA !== numericB ? (numericA ? -1 : 1) : compare(a[i], b[i]);
  }
  return order;
}
