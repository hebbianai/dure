import { sameBrowserPage } from "./browser-action-authority.mjs";

export const networkQueryOptions = ["networkFilter", "networkType", "networkMethod"];

export function browserNetworkQuery(options) {
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!/^[1-9][0-9]*$/.test(options.limit) || !Number.isSafeInteger(limit))) throw new Error("browser_network_limit_invalid");
  const types = options.networkType?.split(",").map((type) => type.trim().toLowerCase());
  if (types?.some((type) => !/^[a-z]+$/.test(type))) throw new Error("browser_network_filter_invalid");
  const method = options.networkMethod;
  if (method !== undefined && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) throw new Error("browser_network_filter_invalid");
  let status;
  if (options.status !== undefined) {
    const value = options.status.toLowerCase();
    if (/^[0-9]xx$/.test(value)) status = [Number(value[0]) * 100, Number(value[0]) * 100 + 99];
    else if (/^\+?[0-9]+(?:-\+?[0-9]+)?$/.test(value)) {
      const [low, high = low] = value.split("-").map(Number);
      status = [low, high];
    }
    if (!status || status.some((code) => !Number.isInteger(code) || code < 0 || code > 65535) || status[0] > status[1]) throw new Error("browser_network_filter_invalid");
  }
  return { url: options.networkFilter, types, method: method?.toUpperCase(), status, limit };
}

/** Filter retained observations only; pending/idle and coverage remain Host facts. */
export function projectBrowserNetwork(result, page, query) {
  if (result?.error || result?.result?.response?.success === false) return result;
  const snapshot = result?.result;
  if (!sameBrowserPage(snapshot?.page, page) || !Array.isArray(snapshot?.requests)) throw new Error("browser_response_invalid");
  let requests = snapshot.requests;
  if (query.url !== undefined || query.types !== undefined || query.method !== undefined || query.status !== undefined) {
    requests = requests.filter((request) => {
      if (!request || ["url", "method", "resource_type"].some((key) => typeof request[key] !== "string")
          || (request.status !== null && (!Number.isInteger(request.status) || request.status < 0 || request.status > 65535))) throw new Error("browser_response_invalid");
      return (query.url === undefined || request.url.includes(query.url))
        && (query.types === undefined || query.types.includes(request.resource_type.toLowerCase()))
        && (query.method === undefined || request.method.toUpperCase() === query.method)
        && (query.status === undefined || (request.status !== null && request.status >= query.status[0] && request.status <= query.status[1]));
    });
  }
  const limited = query.limit === undefined ? {} : { truncated: requests.length > query.limit };
  return { ...result, result: { ...snapshot, requests: query.limit === undefined ? requests : requests.slice(-query.limit), ...limited } };
}
