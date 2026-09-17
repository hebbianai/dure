function() {
  let prototype = Object.getPrototypeOf(this);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "onclick");
    if (descriptor) return descriptor.get.call(this) !== null;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
