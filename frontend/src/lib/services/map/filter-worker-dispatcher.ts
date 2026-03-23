import { MapFilterService } from './map-filter.service.js';

export function createFilterWorkerDispatcher({
  serviceFactory = null
} = {}) {
  let workerService = null;

  function ensureWorkerService() {
    if (!workerService) {
      workerService = typeof serviceFactory === 'function'
        ? serviceFactory()
        : new MapFilterService();
    }
    return workerService;
  }

  function request(type, payload = {}) {
    return ensureWorkerService().request(type, payload);
  }

  function destroy(errorMessage = 'Filter worker terminated') {
    if (!workerService) return;
    workerService.destroy(errorMessage);
    workerService = null;
  }

  return {
    destroy,
    request
  };
}
