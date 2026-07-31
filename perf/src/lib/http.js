import k6http from 'k6/http';
import { check } from 'k6';
import { serviceBaseUrl } from './config.js';
import { bizErrors } from './metrics.js';

// 统一 HTTP 管道：所有 API 调用唯一出口。
// opts: { name(必填,指标tag), module, user, params(query对象), headers, bizCheck(res=>bool) }
function request(method, cfg, service, path, body, opts) {
  if (!opts || !opts.name) throw new Error('http: opts.name tag is required');
  const entries = opts.params ? Object.entries(opts.params) : [];
  const qs = entries.length
    ? '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const url = serviceBaseUrl(cfg, service) + path + qs;
  const params = {
    headers: Object.assign(
      { Accept: 'application/json' },
      opts.user ? { 'X-User-Id': opts.user } : {},
      opts.headers || {},
    ),
    tags: { name: opts.name, service, module: opts.module || 'default' },
  };
  const res = method === 'GET' ? k6http.get(url, params) : k6http.post(url, body, params);
  const httpOk = res.status >= 200 && res.status < 300;
  const bizOk = httpOk && (!opts.bizCheck || opts.bizCheck(res));
  check(res, { [`${opts.name} ok`]: () => bizOk });
  if (httpOk && !bizOk) bizErrors.add(1, params.tags);
  return res;
}

export function get(cfg, service, path, opts) {
  return request('GET', cfg, service, path, null, opts);
}

export function postJson(cfg, service, path, body, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, JSON.stringify(body), o);
}

export function postMultipart(cfg, service, path, formData, opts) {
  // k6 对含 http.file 的对象 body 自动生成 multipart 边界
  return request('POST', cfg, service, path, formData, opts);
}
