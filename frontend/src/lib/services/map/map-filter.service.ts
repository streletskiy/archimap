const DEFAULT_WORKER_ERROR = 'Filter worker crashed';

export class MapFilterService {
  workerFactory: () => Worker;
  worker: Worker | null;
  requestSeq: number;
  pending: Map<string, {
    resolve: (value: LooseRecord) => void;
    reject: (error: unknown) => void;
  }>;

  constructor({
    workerFactory = null
  }: LooseRecord = {}) {
    this.workerFactory = workerFactory || (() => new Worker(
      new URL('../../workers/building-filter.worker.ts', import.meta.url),
      { type: 'module' }
    ));
    this.worker = null;
    this.requestSeq = 0;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker || typeof Worker === 'undefined') return this.worker;

    this.worker = this.workerFactory();
    this.worker.onmessage = (event) => {
      const data = event?.data || {};
      const requestId = String(data?.requestId || '');
      const handlers = this.pending.get(requestId);
      if (!handlers) return;
      this.pending.delete(requestId);
      handlers.resolve(data);
    };
    this.worker.onerror = () => {
      this.rejectPending(new Error(DEFAULT_WORKER_ERROR));
    };

    return this.worker;
  }

  request(type, payload: LooseRecord = {}) {
    this.ensureWorker();
    if (!this.worker) {
      return Promise.reject(new Error('Filter worker is unavailable'));
    }

    const requestId = `w-${Date.now()}-${++this.requestSeq}`;
    return new Promise<LooseRecord>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({
        type,
        requestId,
        ...payload
      });
    });
  }

  rejectPending(error) {
    for (const [requestId, handlers] of this.pending.entries()) {
      this.pending.delete(requestId);
      handlers.reject(error);
    }
  }

  destroy(errorMessage = 'Filter worker terminated') {
    this.rejectPending(new Error(errorMessage));
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending = new Map();
  }
}
