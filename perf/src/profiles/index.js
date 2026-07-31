// 五种标准负载形状。默认 open model（arrival-rate）：被测系统变慢时压力不衰减，
// 避免 coordinated omission。RATE/DURATION/MAX_VUS 可经 __ENV 覆盖。
const HARD_MAX_VUS = 500;

const PROFILES = {
  smoke: () => ({
    executor: 'constant-arrival-rate',
    rate: 2, timeUnit: '1s', duration: '1m',
    preAllocatedVUs: 5, maxVUs: 10,
  }),
  load: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 20, maxVUs: o.maxVUs,
    stages: [
      { duration: '2m', target: o.rate },
      { duration: o.duration, target: o.rate },
      { duration: '1m', target: 0 },
    ],
  }),
  stress: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 50, maxVUs: o.maxVUs,
    stages: [
      { duration: '2m', target: o.rate },
      { duration: '2m', target: o.rate * 2 },
      { duration: '2m', target: o.rate * 3 },
      { duration: '2m', target: o.rate * 4 },
      { duration: '1m', target: 0 },
    ],
  }),
  spike: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 50, maxVUs: o.maxVUs,
    stages: [
      { duration: '10s', target: o.rate * 5 },
      { duration: '1m', target: o.rate * 5 },
      { duration: '10s', target: o.rate },
      { duration: '2m', target: o.rate },
    ],
  }),
  soak: (o) => ({
    executor: 'constant-arrival-rate',
    rate: o.rate, timeUnit: '1s', duration: '2h',
    preAllocatedVUs: 30, maxVUs: o.maxVUs,
  }),
};

export function buildProfile(name, env = {}) {
  const make = PROFILES[name];
  if (!make) throw new Error(`unknown profile: ${name} (want ${Object.keys(PROFILES).join('/')})`);
  const o = {
    rate: Number(env.RATE || 20),
    duration: env.DURATION || '10m',
    maxVUs: Math.min(Number(env.MAX_VUS || 100), HARD_MAX_VUS),
  };
  return make(o);
}
