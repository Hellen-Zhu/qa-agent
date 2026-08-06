# Seed Runbook：消耗池铺底操作手册

适用：update / approve 这类**每笔请求消耗一个前置 id** 的场景。数据分类与总体策略见 `test-plan.md` §6；本文只讲怎么跑。

## 0. 前置检查（首次跑 seed 前）

内网副本 `config/environments/dev.json` 确认三样：

- [ ] `services.worker-svc` 真实地址；
- [ ] `users.maker` 真实账号（20 个）；
- [ ] **`users.checker` 至少 1 个真实 checker 账号**——seed 的 approve 段用 checker 身份；占位账号会得到 401/403/409 类拒绝。长期需扩池 20（env-checklist）。

## 1. 试铺（首次 20 笔，验证流水线）

```bash
./run.sh seed-update-pool dev seed ITERATIONS=20
```

读输出（按序）：

1. **终端三分类**：每迭代发 2 个请求（create + approve），全顺利 `total ≈ 40, ok ≈ 40`；
2. **收割行**：`seed pool: .../seed-pool.json ← N ids harvested`——N = 走完两步的迭代数，这就是成绩单；
3. 三种典型偏差：
   - **N=0 但 create 有 ok** → k6.log 搜 `no TaskId in msg`（msg 格式漂移，需调 extractTaskId 正则）；
   - **http-429 涌现** → checker 单账号被 10 VU 并发打限流：重试加 `VUS=2` 压低并发，同时推进 checker 扩池申请；
   - **http-409** → 先查身份池配置（maker/checker 是否填反），不是性能信号。

## 2. 激活池子

```bash
cp results/<UTC日期>/seed-update-pool_dev_seed_<runId>/seed-pool.json \
   data/worker-svc/trade/update-ids.json
```

runner 有意**不自动覆盖** data/ 下的池文件——换池销毁旧池，是人的决定（见 §5 设计说明）。

## 3. 池量算术（preflight 的账）

preflight 要求：**池量 ≥ 计划迭代 × 1.2**。计划迭代按 profile 推算：

| 轮次 | 计划迭代 | 需要池量 | 铺底命令参考 |
|---|---|---|---|
| smoke（单用户单次） | 1 | 2 | 试铺 20 绰绰有余 |
| load RATE=2 × 10m | 1,200 | 1,440 | `ITERATIONS=1900`（×1.3 计入 seed 自身损耗） |
| load RATE=20 × 10m | 12,000 | 14,400 | `ITERATIONS=19000`（此规模先看 §4 的 bulk 判据） |

seed 的 `ITERATIONS` 建议 = 目标池量 × 1.3：部分迭代会因业务拒绝 / TaskId 缺失而没有产出。

## 4. 何时引入 bulk-approve 加速器

判据与设计已记 env-checklist：真实试铺后外推全量池耗时——不可接受再按"迭代=批"设计实现 bulk 版 seed；引入前先验证 bulk 的部分失败语义（混一个无效 id 试一次）。压测对象始终是单笔 approve，bulk 只是铺底工具。

## 5. 设计说明：为什么铺底不作为前置自动触发

刻意的四个理由，不是没做完：

1. **时长不可预期**：大池铺底可能 10+ 分钟——隐式触发会把"跑一轮 smoke"变成"不知不觉先灌库一刻钟"，施压轮应当职责单一、时长可预期；
2. **测量纯度**：seed 与测量同轮会共享 testid——三分类总账、Grafana 对账区、report.html 全部混入铺底流量；分轮 = 分 testid，隔离是免费的；
3. **激活是不可逆闸门**：自动 cp 会静默销毁上一个池（里面可能还有没用完的 id）；铺多大、何时换池取决于当轮计划，这个判断不该交给脚本；
4. **失败需要人裁决**：铺底失败（429/数据问题/契约漂移）若自动链式触发测量轮，产出的是"半池 + preflight 拦截"的混乱现场，排障成本更高。

将来若流程跑熟、日常化到嫌手动烦，可以做 opt-in 的三连 wrapper（seed → cp → run），但默认永远显式分步。

## 6. 顺手实验：409 语义（一次性，关 spec §11-10 悬案）

试铺后从 k6.log 挑一个已批过的 `CHK-…`，手工 curl 再 approve 一次，记录响应状态码与 body——这就是"409 是否兼作状态冲突"的裁决证据，拿到后更新 spec §11 与错误引擎的 409 归因注释。
