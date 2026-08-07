import k6http from 'k6/http';
import { serviceBaseUrl } from './config.js';

// Unified HTTP pipeline: the single exit point for all API calls, responsible only for
// "getting the request out the door" — baseUrl resolution, default request headers,
// low-cardinality metric tags. Response classification is the api layer's contract duty
// (lib/errors.js), so this returns {res, tags} for the caller to feed into the classification
// engine.
// opts: { name (required, metric tag), module, user, params (query object), headers,
//         tags (additional low-cardinality tags) }
function request(method, cfg, service, path, body, opts) {
  if (!opts || !opts.name) throw new Error('http: opts.name tag is required');
  const entries = opts.params ? Object.entries(opts.params) : [];
  const qs = entries.length
    ? '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  const url = serviceBaseUrl(cfg, service) + path + qs;
  const params = {
    headers: Object.assign(
      { Accept: 'application/json' },
      opts.user ? { 'X-User-Id': opts.user } : {},
      opts.headers || {},
    ),
    tags: Object.assign(
      { name: opts.name, service, module: opts.module || 'default' },
      opts.tags || {},
    ),
  };
  const res = method === 'GET' ? k6http.get(url, params) : k6http.post(url, body, params);
  return { res, tags: params.tags };
}

export function get(cfg, service, path, opts) {
  return request('GET', cfg, service, path, null, opts);
}

export function postJson(cfg, service, path, body, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, JSON.stringify(body), o);
}

export function postEmpty(cfg, service, path, opts) {
  // Empty-body POST (checker task actions take no payload — calibrated curl sends -d '').
  // Content-Type still json to mirror the captured request exactly.
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, '', o);
}

export function postMultipart(cfg, service, path, formData, opts) {
  // An object body containing http.file() is multipart-encoded by k6 automatically, boundary
  // included; never hand-write Content-Type — a hand-written value has no boundary and would
  // override the generated one, leaving the server unable to split the parts
  return request('POST', cfg, service, path, formData, opts);
}
