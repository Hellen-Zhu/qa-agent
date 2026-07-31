// 纯配置解析与白名单校验。文件读取发生在场景脚本的 init 阶段（k6 open()），
// 这里只处理文本 —— 因此本模块可同时被 k6 与 Node 加载。
// 注意：k6 运行时没有 WHATWG URL，主机名用字符串解析。
function hostOf(url) {
  return url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
}

export function assertWhitelisted(url, whitelist, label = url) {
  const host = hostOf(url);
  const ok = whitelist.some((w) => host === w || host.endsWith(`.${w}`));
  if (!ok) throw new Error(`target not whitelisted: ${label} -> ${host}`);
}

export function parseEnvConfig(rawText) {
  const cfg = JSON.parse(rawText);
  for (const key of ['name', 'whitelist', 'promRwUrl', 'services', 'users']) {
    if (!(key in cfg)) throw new Error(`config missing field: ${key}`);
  }
  for (const [svc, url] of Object.entries(cfg.services)) {
    assertWhitelisted(url, cfg.whitelist, svc);
  }
  return cfg;
}

export function serviceBaseUrl(cfg, service) {
  const url = cfg.services[service];
  if (!url) throw new Error(`unknown service: ${service}`);
  return url;
}
