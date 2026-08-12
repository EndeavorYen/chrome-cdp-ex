import {
  createLocatorPlan,
  isResolvedHandle,
  resolveLocatorPlanToHandle,
} from './browser-resources.mjs';

const DEPENDENCY_KEYS = new Set(['discover', 'endpointFor', 'open', 'inspect', 'request', 'stop']);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotDependencies(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('browserSupervisor.dependencies', 'must be a plain object');
  }
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol') fail('browserSupervisor.dependencies', 'symbol keys are not allowed');
    if (!DEPENDENCY_KEYS.has(key)) fail(`browserSupervisor.dependencies.${key}`, 'is not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`browserSupervisor.dependencies.${key}`, 'accessor properties are not allowed');
    if (typeof descriptor.value !== 'function') fail(`browserSupervisor.dependencies.${key}`, 'must be a function');
    output[key] = descriptor.value;
  }
  for (const key of DEPENDENCY_KEYS) if (!Object.hasOwn(output, key)) fail(`browserSupervisor.dependencies.${key}`, 'is required');
  return Object.freeze(output);
}

function inspectMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('browserSupervisor.inspect result', 'must be a plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') fail('browserSupervisor.inspect result', 'symbol keys are not allowed');
    if (key !== 'boundTargetId' && key !== 'endpoint') fail(`browserSupervisor.inspect result.${key}`, 'is not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`browserSupervisor.inspect result.${key}`, 'accessor properties are not allowed');
  }
  return { boundTargetId: value.boundTargetId, endpoint: value.endpoint };
}

class SupervisorBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createBrowserSupervisor(input) {
  const dependencies = snapshotDependencies(input);
  const records = new WeakMap();
  const runtimes = new Map();
  const operations = new Set();
  let closed = false;
  let cleanupComplete = false;
  let closePromise = null;

  const keyFor = record => `${record.targetId}\u0000${record.endpoint}`;

  function runtimeFor(record) {
    const key = keyFor(record);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = {
        key,
        targetId: record.targetId,
        endpoint: record.endpoint,
        connection: undefined,
        opening: null,
        operations: new Map(),
        owners: new Set(),
        epoch: 0,
        stopping: false,
        terminateRequested: false,
        stopPromise: null,
      };
      runtimes.set(key, runtime);
    }
    return runtime;
  }

  function ensureRuntimeCleanup(runtime, { waitForOwners = false } = {}) {
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopPromise = (async () => {
      const pending = waitForOwners
        ? [...runtime.owners].flatMap(owner => [...owner.operations])
        : [...runtime.operations.keys()];
      await Promise.allSettled(pending);
      await dependencies.stop(runtime.targetId, runtime.endpoint, runtime.connection);
      if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
    })().finally(() => { runtime.stopPromise = null; });
    return runtime.stopPromise;
  }

  async function stopSharedRuntime(runtime) {
    if (!runtime.terminateRequested) {
      runtime.terminateRequested = true;
      runtime.stopping = true;
      runtime.epoch += 1;
      for (const owner of runtime.owners) {
        owner.stopping = true;
        owner.epoch += 1;
      }
    }
    await ensureRuntimeCleanup(runtime, { waitForOwners: true });
    await Promise.allSettled([...runtime.owners].flatMap(owner => [...owner.operations]));
    for (const owner of runtime.owners) {
      owner.stopped = true;
      owner.stopping = false;
    }
  }

  async function retireRuntimeForRecovery(runtime, recoveringRecord) {
    if (runtime.stopping) fail('browserSupervisor', 'runtime is stopping');
    runtime.stopping = true;
    runtime.epoch += 1;
    for (const owner of runtime.owners) {
      if (owner === recoveringRecord) continue;
      owner.stopping = true;
      owner.epoch += 1;
    }
    await ensureRuntimeCleanup(runtime);
    if (runtime.terminateRequested || recoveringRecord.stopped || recoveringRecord.stopping || closed) {
      fail('browserSupervisor', 'closed or stopped during recovery');
    }
    for (const owner of runtime.owners) {
      if (owner === recoveringRecord) continue;
      owner.stopped = true;
      owner.stopping = false;
    }
    runtime.owners.delete(recoveringRecord);
    if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
  }

  async function inspectConnection(record, connection) {
    const metadata = inspectMetadata(await dependencies.inspect(connection));
    if (metadata.endpoint !== record.endpoint) {
      throw new SupervisorBindingError('ENDPOINT_MISMATCH', 'Browser supervisor endpoint mismatch');
    }
    if (metadata.boundTargetId !== record.targetId) {
      throw new SupervisorBindingError('TARGET_MISMATCH', 'Browser supervisor target mismatch');
    }
    return connection;
  }

  async function openInspected(record, runtime) {
    if (runtime.stopping) fail('browserSupervisor', 'runtime is stopping');
    if (runtime.connection) return runtime.connection;
    if (runtime.opening) return runtime.opening;
    const promise = (async () => {
      let first;
      try {
        first = await dependencies.open(record.targetId, record.endpoint);
        await inspectConnection(record, first);
        runtime.connection = first;
        return first;
      } catch (firstError) {
        if (!(firstError instanceof SupervisorBindingError) || firstError.code !== 'TARGET_MISMATCH') throw firstError;
        if (first) await dependencies.stop(record.targetId, record.endpoint, first);
      }
      const second = await dependencies.open(record.targetId, record.endpoint);
      try {
        await inspectConnection(record, second);
      } catch (secondError) {
        await dependencies.stop(record.targetId, record.endpoint, second);
        throw secondError;
      }
      runtime.connection = second;
      return second;
    })().finally(() => { runtime.opening = null; });
    runtime.opening = promise;
    return promise;
  }

  async function resolveDetail(plan) {
    let detail;
    await resolveLocatorPlanToHandle(plan, {
      discover: dependencies.discover,
      endpointFor: dependencies.endpointFor,
      transportFor: resolved => {
        detail = resolved;
        return { request: async () => { throw new Error('unbound temporary handle'); } };
      },
    });
    return detail;
  }

  async function refreshRecord(record) {
    if (record.refreshing) return record.refreshing;
    record.refreshing = (async () => {
      const current = await resolveDetail(record.plan);
      if (closed || record.stopped || record.stopping) fail('browserSupervisor', 'closed or stopped during refresh');
      if (current.targetId === record.targetId && current.endpoint === record.endpoint) {
        if (current.resource.kind !== record.resource.kind || current.resource.id !== record.resource.id) {
          fail('browserSupervisor', 'resource identity drifted for the same runtime binding');
        }
        if (current.resource.revision < record.resource.revision) {
          fail('browserSupervisor', 'resource revision regressed for the same runtime binding');
        }
        if (current.resource.revision === record.resource.revision
          && JSON.stringify(current.resource) !== JSON.stringify(record.resource)) {
          fail('browserSupervisor', 'resource changed without a revision advance');
        }
        record.resource = current.resource;
        record.browser = current.browser;
        return;
      }
      if (record.recoveries >= 1) throw new Error('Browser supervisor refused more than one recovery for a resolved handle');
      record.recoveries += 1;
      const previousRuntime = runtimeFor(record);
      await retireRuntimeForRecovery(previousRuntime, record);
      record.resource = current.resource;
      record.targetId = current.targetId;
      record.endpoint = current.endpoint;
      record.browser = current.browser;
      runtimeFor(record).owners.add(record);
    })().finally(() => { record.refreshing = null; });
    return record.refreshing;
  }

  function executeRecord(record, request) {
    let operation;
    let runtime;
    operation = (async () => {
      if (closed || record.stopped || record.stopping) fail('browserSupervisor', 'is closed or stopped');
      const recordEpoch = record.epoch;
      await refreshRecord(record);
      if (closed || record.stopped || record.stopping || record.epoch !== recordEpoch) fail('browserSupervisor', 'closed or stopped during refresh');
      runtime = runtimeFor(record);
      const runtimeEpoch = runtime.epoch;
      runtime.operations.set(operation, record);
      if (runtime.stopping) fail('browserSupervisor', 'runtime is stopping');
      const connection = await openInspected(record, runtime);
      if (closed || record.stopped || record.stopping || record.epoch !== recordEpoch
        || runtime.stopping || runtime.epoch !== runtimeEpoch) {
        fail('browserSupervisor', 'closed or stopped during connection open');
      }
      try {
        return await dependencies.request(connection, request);
      } catch (error) {
        if (runtime.connection === connection) runtime.connection = undefined;
        throw error;
      }
    })().finally(() => {
      operations.delete(operation);
      record.operations.delete(operation);
      runtime?.operations.delete(operation);
    });
    operations.add(operation);
    record.operations.add(operation);
    return operation;
  }

  async function resolve(planInput) {
    if (closed) fail('browserSupervisor', 'is closed');
    const plan = createLocatorPlan(planInput);
    let record;
    let detail;
    const handle = await resolveLocatorPlanToHandle(plan, {
      discover: dependencies.discover,
      endpointFor: dependencies.endpointFor,
      transportFor: resolved => {
        detail = resolved;
        return {
          request: request => executeRecord(record, request),
          resource: () => record?.resource || resolved.resource,
        };
      },
    });
    if (closed) fail('browserSupervisor', 'closed during resolve');
    record = {
      plan, ...detail, recoveries: 0, stopped: false, stopping: false,
      epoch: 0, refreshing: null, operations: new Set(),
    };
    records.set(handle, record);
    runtimeFor(record).owners.add(record);
    return handle;
  }

  async function execute(handle, request) {
    if (closed) fail('browserSupervisor', 'is closed');
    if (!isResolvedHandle(handle) || !records.has(handle)) fail('browserSupervisor.handle', 'must be a private handle created by this supervisor');
    const record = records.get(handle);
    if (record.stopped) fail('browserSupervisor.handle', 'has been stopped');
    return handle.execute(request);
  }

  async function stop(handle) {
    if (!isResolvedHandle(handle) || !records.has(handle)) fail('browserSupervisor.handle', 'must be a private handle created by this supervisor');
    const record = records.get(handle);
    if (record.stopped) return;
    try {
      await stopSharedRuntime(runtimeFor(record));
    } catch (error) {
      record.stopping = true;
      throw error;
    }
  }

  async function close() {
    if (cleanupComplete) return;
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await Promise.allSettled([...operations]);
      const pending = [...runtimes.values()].filter(runtime => (
        runtime.connection || runtime.stopPromise || runtime.stopping
      ));
      const results = await Promise.allSettled(pending.map(runtime => stopSharedRuntime(runtime)));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Browser supervisor cleanup failed');
      cleanupComplete = true;
    })().finally(() => { closePromise = null; });
    return closePromise;
  }

  return Object.freeze({ resolve, execute, stop, close });
}
