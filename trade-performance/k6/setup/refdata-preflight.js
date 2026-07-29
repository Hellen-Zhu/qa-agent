/*
 * setup/refdata-preflight.js —— **refdata 查询路径**的开跑前守卫
 *
 * 命名约定见 setup/create-trade-preflight.js 头注。
 * 谁在用：scenarios/s01-create-trade-e2e.js（E2E 才踩 refdata；p02 不踩）
 *
 * ── 它守的是"降级有没有被悄悄启用" ──
 * refdata 服务地址在 config 里仍是 localhost 占位（NFR 待确认 #12）。
 * live 模式下地址不对 = 每次迭代都静默走 fallback，跑完得到一份
 * "看起来正常但根本没覆盖 refdata 查询"的报告。所以这里**开跑前就断言**，
 * 不可达直接中止，并给出两条明确出路。
 *
 * static 模式不发请求，只打一条偏差声明 —— 报告里必须写明。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { portfoliosList } from '../steps/refdata/portfolios-list.js';
import { ERR } from '../lib/errors.js';

/**
 * @param {string} mode  'live' | 'static'
 */
export function refdataPreflight(mode) {
  console.log(`── preflight: refdata（mode=${mode}）─────────`);

  if (mode !== 'live') {
    console.warn('⚠ REFDATA_MODE=static —— 不覆盖 refdata 查询路径，报告必须标注此偏差');
    return;
  }

  const probe = portfoliosList({ runPhase: 'setup' });
  if (probe.errClass !== ERR.OK) {
    exec.test.abort(
      `PREFLIGHT FAILED — refdata 不可达（${probe.detail}）。` +
      `config/${cfg.envName}.json 的 refdata 地址可能仍是占位值（NFR 待确认 #12）。` +
      `两条路：① 向架构确认地址后填入 config；② 临时用 REFDATA_MODE=static 跑` +
      `（降级：不覆盖下拉框查询，报告须标注偏差）`
    );
  }
  console.log(`✓ refdata 可达（${probe.list.length} 个 portfolio）`);
}
