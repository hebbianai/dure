const PRIVATE_TEST_MODULE =
  /^hmux\/crates\/[^/]+\/src\/(?:.+\/)?tests\.rs$/;
const PRIVATE_TEST_TREE =
  /^hmux\/crates\/[^/]+\/src\/(?:.+\/)?tests\/.+\.rs$/;

export function isHmuxTestOnlyPath(path) {
  return (
    typeof path === "string" &&
    (PRIVATE_TEST_MODULE.test(path) || PRIVATE_TEST_TREE.test(path))
  );
}
