export function browserActionAuthority(control, page, options, operationId) {
  const { lease, operation_id, command_sequence } = browserControllerAuthority(control, options, operationId);
  return { lease, page, operation_id, command_sequence };
}

export function browserControllerAuthority(control, options, operationId) {
  const lease = control.controller;
  if (!lease || lease.controller_id !== options.controller || lease.epoch !== options.epoch) throw new Error("browser_controller_changed");
  return { lease, operation_id: operationId, command_sequence: control.next_command_sequence };
}

export function sameBrowserPage(left, right) {
  return !!left && !!right && left.page_id === right.page_id && left?.document_revision === right?.document_revision
    && ["resource_id", "generation", "workspace_id"].every((key) => left?.resource?.[key] === right?.resource?.[key]);
}

export function browserCurrentPage(control) {
  const page = control?.current_page;
  if (page === undefined || page === null) throw new Error("browser_page_required");
  if (typeof page.page_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(page.page_id)
      || typeof page.document_revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(page.document_revision)
      || BigInt(page.document_revision) > 18446744073709551615n
      || ["resource_id", "generation", "workspace_id"].some((key) => typeof page.resource?.[key] !== "string" || page.resource[key] !== control.resource?.[key])) throw new Error("browser_response_invalid");
  return page;
}
