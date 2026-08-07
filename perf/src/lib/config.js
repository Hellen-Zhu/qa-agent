// Pure config parsing and whitelist validation. File reading happens in the scenario script's
// init phase (k6 open()); this module handles text only — so it can be loaded by both k6 and Node.
// Note: the k6 runtime has no WHATWG URL, so hostnames are parsed with string operations.
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
