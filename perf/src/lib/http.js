import k6http from 'k6/http';
import { serviceBaseUrl } from './config.js';

// 统一 HTTP 管道：所有 API 调用唯一出口，只负责"把请求发出去"——
// baseUrl 解析、默认请求头、低基数指标 tag。响应分类是 api 层的契约职责
// （lib/errors.js），因此返回 {res, tags} 交给调用方送入分类引擎。
// opts: { name(必填,指标tag), module, user, params(query对象), headers, tags(附加低基数tag) }
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

export function postMultipart(cfg, service, path, formData, opts) {
  // 含 http.file() 的对象 body 由 k6 自动编码 multipart 并生成 boundary；
  // 严禁手写 Content-Type——手写值没有 boundary，会覆盖生成值导致服务端无法分包
  return request('POST', cfg, service, path, formData, opts);
}
