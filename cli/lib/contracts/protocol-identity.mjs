const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER_CONVERSATION_REF = /^[A-Za-z0-9._:/-]{1,160}$/;
const WIRE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const BACKEND_PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function isDureDomainIdV1(value) {
  return typeof value === "string" && DOMAIN_ID.test(value);
}

/** Provider references may start with punctuation and contain path segments. */
export function isDureProviderConversationRefV1(value) {
  return typeof value === "string" && PROVIDER_CONVERSATION_REF.test(value);
}

export function isDureWireTokenV1(value) {
  return typeof value === "string" && WIRE_TOKEN.test(value);
}

export function isDureBackendProfileIdV1(value) {
  return typeof value === "string" && BACKEND_PROFILE_ID.test(value);
}
