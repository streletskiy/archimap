const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadMapFilterService() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-filter.service.ts');
  return import(pathToFileURL(modulePath).href);
}

test('MapFilterService forwards request-plan and resolved-payload worker messages', async () => {
  const { MapFilterService } = await loadMapFilterService();
  const postedMessages = [];
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: function WorkerShim() {}
  });
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      postedMessages.push(message);
      queueMicrotask(() => {
        if (typeof worker.onmessage !== 'function') return;

        if (message.type === 'build-request-plan') {
          worker.onmessage({
            data: {
              type: 'build-request-plan-result',
              requestId: message.requestId,
              ok: true,
              layers: [
                {
                  id: 'layer-1',
                  color: '#111111',
                  priority: 0,
                  mode: 'layer',
                  rules: [
                    {
                      key: 'name',
                      op: 'contains',
                      value: 'alpha',
                      valueNormalized: 'alpha',
                      numericValue: null
                    }
                  ]
                }
              ],
              requestSpecs: [
                {
                  id: 'layer:layer-1',
                  kind: 'layer',
                  groupId: 'layer-1',
                  layerId: 'layer-1',
                  rules: [
                    {
                      key: 'name',
                      op: 'contains',
                      value: 'alpha',
                      valueNormalized: 'alpha',
                      numericValue: null
                    }
                  ],
                  rulesHash: 'fnv1a-test',
                  color: '#111111',
                  priority: 0
                }
              ],
              combinedGroup: null,
              hasStandaloneLayers: true,
              rulesHash: 'fnv1a-test',
              heavy: true
            }
          });
          return;
        }

        if (message.type === 'build-resolved-payload') {
          worker.onmessage({
            data: {
              type: 'build-resolved-payload-result',
              requestId: message.requestId,
              ok: true,
              highlightColorGroups: [
                { color: '#111111', ids: [2] }
              ],
              matchedFeatureIds: [2],
              matchedCount: 1,
              meta: {
                rulesHash: 'fnv1a-test',
                bboxHash: 'bbox:test',
                truncated: false,
                elapsedMs: 12,
                cacheHit: Boolean(message.cacheHit),
                coverageHash: 'coverage:test',
                coverageWindow: null,
                zoomBucket: 4
              }
            }
          });
        }
      });
    },
    terminate() {}
  };

  try {
    const service = new MapFilterService({
      workerFactory: () => worker
    });

    const plan = await service.request('build-request-plan', {
      rules: [
        { key: 'name', op: 'contains', value: 'alpha' }
      ]
    });

    assert.equal(plan.ok, true);
    assert.equal(postedMessages[0].type, 'build-request-plan');

    const resolved = await service.request('build-resolved-payload', {
      prepared: plan.ok ? plan : {
        layers: [],
        combinedGroup: null,
        requestSpecs: [],
        hasStandaloneLayers: false,
        rulesHash: 'fnv1a-0',
        heavy: false
      },
      payloads: [
        {
          requestId: 'layer:layer-1',
          payload: {
            matchedKeys: ['way/1'],
            matchedFeatureIds: [2],
            meta: {
              rulesHash: 'fnv1a-test',
              bboxHash: 'bbox:test',
              truncated: false,
              elapsedMs: 12,
              cacheHit: true,
              coverageHash: 'coverage:test',
              coverageWindow: null,
              zoomBucket: 4
            }
          }
        }
      ],
      cacheHit: true
    });

    assert.equal(resolved.ok, true);
    assert.equal(postedMessages[1].type, 'build-resolved-payload');
    service.destroy();
  } finally {
    if (typeof originalWorker === 'undefined') {
      delete globalThis.Worker;
    } else {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWorker
      });
    }
  }
});
