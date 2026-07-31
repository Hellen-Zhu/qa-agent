// JSON 数据文件解析契约（纯逻辑，Node 可加载）。
// 顶层为数组，或含 rows 数组的对象；「_」开头的键（顶层与行内）是注释，装载时剥除；
// 标量值一律转为去空白字符串（null/undefined → ''）——payload 是否发数值由组装方决定；
// 自动注入 __row（1 起始行号）作为行身份，用于指标 tag 与 preflight 报错定位。
// 注意 note 不带下划线——它是真实数据列（记采集时间与来源），不要写成 _note。
export function rowsFromJson(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${sourceName} 不是合法 JSON — ${e.message}。` +
      `常见原因：JSON 不允许注释与尾逗号——注释写成 _ 开头的键`
    );
  }

  let rows;
  if (Array.isArray(doc)) rows = doc;
  else if (doc && Array.isArray(doc.rows)) rows = doc.rows;
  else {
    throw new Error(`${sourceName} 结构错误：顶层应为数组，或含 rows 数组的对象（其余 _ 开头键为注释）`);
  }

  return rows.map((r, idx) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`${sourceName} 第 ${idx + 1} 行不是对象——每行应为 {"字段": "值"}`);
    }
    const out = { __row: idx + 1 };
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return;
      const v = r[k];
      out[k] = v === null || v === undefined ? '' : String(v).trim();
    });
    return out;
  });
}
