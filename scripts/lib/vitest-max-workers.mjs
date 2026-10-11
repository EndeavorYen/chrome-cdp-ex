// Worker budget for `npm test`.
//
// Vitest's non-watch forks pool defaults to max(cpuCount - 1, 1): 3 workers on
// a 4-vCPU host. One full-suite run peaked at 2570 MiB summed process RSS with
// one worker, and 6249 MiB with three (Node 22, Vitest 3 forks). Budget 3 GiB
// per worker, above that single-worker peak, and keep
// 1 GiB in reserve. Do not exceed the CPU cap unless the env override asks.

export const VITEST_MAX_WORKERS_ENV = 'CHROME_CDP_EX_VITEST_MAX_WORKERS';
export const VITEST_WORKER_BUDGET_BYTES = 3 * 1024 * 1024 * 1024;
export const VITEST_WORKER_RESERVE_BYTES = 1024 * 1024 * 1024;
export const VITEST_WORKER_OVERRIDE_MAX = 64;

export function vitestCpuWorkerCap(cpuCount) {
  const count = Number(cpuCount);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.max(1, Math.floor(count) - 1);
}

export function parseVitestWorkerOverride(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(
      `${VITEST_MAX_WORKERS_ENV} must be an integer from 1 to ${VITEST_WORKER_OVERRIDE_MAX}, got ${JSON.stringify(value)}`,
    );
  }
  const parsed = Number(text);
  if (parsed > VITEST_WORKER_OVERRIDE_MAX) {
    throw new Error(
      `${VITEST_MAX_WORKERS_ENV} must be an integer from 1 to ${VITEST_WORKER_OVERRIDE_MAX}, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function resolveVitestMaxWorkers({
  totalMemBytes,
  freeMemBytes,
  cpuCount,
  override,
  budgetBytes = VITEST_WORKER_BUDGET_BYTES,
  reserveBytes = VITEST_WORKER_RESERVE_BYTES,
} = {}) {
  const explicit = parseVitestWorkerOverride(override);
  if (explicit != null) return explicit;

  const cap = vitestCpuWorkerCap(cpuCount);
  const budget = Number(budgetBytes);
  if (!Number.isFinite(budget) || budget <= 0) return cap;

  const total = Number(totalMemBytes);
  const free = Number(freeMemBytes);
  const limits = [];
  if (Number.isFinite(total) && total > 0) limits.push(total);
  if (Number.isFinite(free) && free >= 0) limits.push(free);
  if (limits.length === 0) return 1;

  const usable = Math.min(...limits) - (Number.isFinite(Number(reserveBytes)) ? Number(reserveBytes) : 0);
  if (!(usable >= budget)) return 1;
  return Math.max(1, Math.min(cap, Math.floor(usable / budget)));
}

export function vitestArgsSetMaxWorkers(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return args.some((arg, index) => {
    const text = String(arg);
    if (text === '--maxWorkers' || text === '--max-workers') {
      const next = args[index + 1];
      return next != null && !String(next).startsWith('-');
    }
    return text.startsWith('--maxWorkers=') || text.startsWith('--max-workers=');
  });
}
