const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadModule(modulePath: string) {
  return import(pathToFileURL(path.join(process.cwd(), modulePath)).href);
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

function copyHeaders(initHeaders: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(initHeaders || {});
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

type RequestRecord = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

test('bulk edit skips buildings that already match the target values', async () => {
  const { get } = await import('svelte/store');
  const { session } = await loadModule('frontend/src/lib/stores/auth.ts');
  const { clearSelectedBuildings, selectedBuildings } = await loadModule('frontend/src/lib/stores/map.ts');
  const { createBuildingDetailsManager } = await loadModule('frontend/src/lib/services/building-details-manager.ts');

  const originalFetch = global.fetch;
  const requests: RequestRecord[] = [];

  session.set({
    loading: false,
    authenticated: true,
    csrfToken: 'csrf-token',
    user: {
      email: 'editor@example.com'
    }
  });
  clearSelectedBuildings();

  global.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method,
      headers: copyHeaders(init.headers),
      body
    });

    if (method === 'GET' && url.endsWith('/api/building-info/way/1')) {
      return createJsonResponse({
        feature_kind: 'building',
        region_slugs: [],
        name: 'Alpha House',
        style: 'old-style',
        roof_shape: 'flat',
        material: 'brick',
        colour: '#222222',
        levels: '3',
        year_built: '1988',
        architect: 'Alice',
        address: 'Main street, 1',
        archimap_description: 'Initial'
      });
    }

    if (method === 'GET' && url.endsWith('/api/building/way/1')) {
      return createJsonResponse({
        properties: {
          feature_kind: 'building',
          source_tags: {}
        }
      });
    }

    if (method === 'GET' && url.endsWith('/api/building-info/way/2')) {
      return createJsonResponse({
        feature_kind: 'building',
        region_slugs: [],
        name: 'Beta House',
        style: 'neo-classical',
        roof_shape: 'gabled',
        material: 'glass',
        colour: '#333333',
        levels: '5',
        year_built: '1991',
        architect: 'Bob',
        address: 'Updated address',
        archimap_description: 'Second'
      });
    }

    if (method === 'GET' && url.endsWith('/api/building/way/2')) {
      return createJsonResponse({
        properties: {
          feature_kind: 'building',
          source_tags: {}
        }
      });
    }

    if (method === 'POST' && url.endsWith('/api/building-info')) {
      return createJsonResponse({
        ok: true,
        editId: 1,
        status: 'pending'
      });
    }

    return createJsonResponse({});
  }) as typeof fetch;

  try {
    const manager = createBuildingDetailsManager();
    const stateSnapshots = [];
    const unsubscribe = manager.subscribe((value) => {
      stateSnapshots.push(value);
    });

    manager.selectBuilding({
      osmType: 'way',
      osmId: 1,
      lon: 37.5,
      lat: 55.7,
      featureKind: 'building'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    manager.selectBuilding({
      osmType: 'way',
      osmId: 2,
      lon: 37.6,
      lat: 55.8,
      featureKind: 'building',
      shiftKey: true
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const selectionState = get(selectedBuildings) as Array<unknown>;
    assert.equal(selectionState.length, 2);
    const beforeSaveState = stateSnapshots[stateSnapshots.length - 1];
    assert.equal(beforeSaveState?.selectedBuildingDetails?.length, 2);

    await manager.saveEdit({
      osmType: 'way',
      osmId: 1,
      name: 'Alpha House',
      style: 'neo-classical',
      roofShape: 'gabled',
      material: 'brick',
      colour: '#111111',
      levels: '4',
      yearBuilt: '1990',
      architect: 'Alice',
      address: 'Updated address',
      archimapDescription: 'Updated note',
      editedFields: ['style', 'address', 'roofShape']
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const postRequests = requests.filter((request) => request.method === 'POST' && request.url.endsWith('/api/building-info'));
    assert.equal(postRequests.length, 1);
    assert.deepEqual(postRequests.map((request) => request.body.osmId), [1]);
    assert.deepEqual(postRequests.map((request) => request.body.editedFields), [
      ['style', 'roofShape']
    ]);
    assert.equal(postRequests[0].body.roofShape, 'gabled');
    assert.equal(postRequests.every((request) => request.body.address === null), true);
    assert.equal(postRequests.every((request) => request.headers['x-csrf-token'] === 'csrf-token'), true);

    const latestState = stateSnapshots[stateSnapshots.length - 1];
    assert.ok(String(latestState?.saveStatus || '').length > 0);

    unsubscribe();
    manager.destroy();
  } finally {
    clearSelectedBuildings();
    session.set({
      loading: false,
      authenticated: false,
      csrfToken: null,
      user: null
    });
    global.fetch = originalFetch;
  }
});

test('building details manager keeps design project suggestions and sends design project fields', async () => {
  const { get } = await import('svelte/store');
  const { session } = await loadModule('frontend/src/lib/stores/auth.ts');
  const { clearSelectedBuildings } = await loadModule('frontend/src/lib/stores/map.ts');
  const { createBuildingDetailsManager } = await loadModule('frontend/src/lib/services/building-details-manager.ts');

  const originalFetch = global.fetch;
  const requests: RequestRecord[] = [];

  session.set({
    loading: false,
    authenticated: true,
    csrfToken: 'csrf-token',
    user: {
      email: 'editor@example.com'
    }
  });
  clearSelectedBuildings();

  global.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method,
      headers: copyHeaders(init.headers),
      body
    });

    if (method === 'GET' && url.endsWith('/api/building-info/way/11')) {
      return createJsonResponse({
        feature_kind: 'building',
        region_slugs: [],
        design: 'typical',
        design_ref: '1-335',
        design_year: '1964',
        design_ref_suggestions: ['1-335', '1-464', '1-335']
      });
    }

    if (method === 'GET' && url.endsWith('/api/building/way/11')) {
      return createJsonResponse({
        properties: {
          feature_kind: 'building',
          source_tags: {
            design: 'typical'
          }
        }
      });
    }

    if (method === 'POST' && url.endsWith('/api/building-info')) {
      return createJsonResponse({
        ok: true,
        editId: 2,
        status: 'pending'
      });
    }

    return createJsonResponse({});
  }) as typeof fetch;

  try {
    const manager = createBuildingDetailsManager();
    manager.selectBuilding({
      osmType: 'way',
      osmId: 11,
      lon: 37.6,
      lat: 55.75,
      featureKind: 'building'
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const beforeSave = get(manager) as any;
    assert.equal(beforeSave.buildingDetails?.properties?.archiInfo?.design_ref, '1-335');
    assert.equal(beforeSave.buildingDetails?.properties?.archiInfo?.design_year, '1964');
    assert.deepEqual(beforeSave.buildingDetails?.design_ref_suggestions, ['1-335', '1-464', '1-335']);

    await manager.saveEdit({
      osmType: 'way',
      osmId: 11,
      design: 'typical',
      designRef: '1-464',
      designYear: '1968',
      editedFields: ['design', 'designRef', 'designYear']
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const postRequest = requests.find((request) => request.method === 'POST' && request.url.endsWith('/api/building-info'));
    assert.ok(postRequest);
    assert.equal(postRequest.body.design, 'typical');
    assert.equal(postRequest.body.designRef, '1-464');
    assert.equal(postRequest.body.designYear, '1968');

    manager.destroy();
  } finally {
    clearSelectedBuildings();
    session.set({
      loading: false,
      authenticated: false,
      csrfToken: null,
      user: null
    });
    global.fetch = originalFetch;
  }
});

test('building details manager preserves pending review metadata for a single building', async () => {
  const { get } = await import('svelte/store');
  const { session } = await loadModule('frontend/src/lib/stores/auth.ts');
  const { clearSelectedBuildings } = await loadModule('frontend/src/lib/stores/map.ts');
  const { createBuildingDetailsManager } = await loadModule('frontend/src/lib/services/building-details-manager.ts');

  const originalFetch = global.fetch;
  const requests: RequestRecord[] = [];

  session.set({
    loading: false,
    authenticated: true,
    csrfToken: 'csrf-token',
    user: {
      email: 'editor@example.com'
    }
  });
  clearSelectedBuildings();

  global.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method,
      headers: copyHeaders(init.headers),
      body
    });

    if (method === 'GET' && url.endsWith('/api/building-info/way/21')) {
      return createJsonResponse({
        feature_kind: 'building',
        review_status: 'pending',
        user_edit_id: 41,
        admin_comment: 'Needs review',
        region_slugs: [],
        name: 'Pending House',
        style: 'modernism',
        material: 'brick',
        colour: '#222222',
        levels: '4',
        year_built: '1999',
        architect: 'Alice',
        address: 'Main street, 21',
        archimap_description: 'Waiting for moderation'
      });
    }

    if (method === 'GET' && url.endsWith('/api/building/way/21')) {
      return createJsonResponse({
        properties: {
          feature_kind: 'building',
          source_tags: {}
        }
      });
    }

    if (method === 'POST' && url.endsWith('/api/building-info')) {
      return createJsonResponse({
        ok: true,
        editId: 41,
        status: 'pending'
      });
    }

    return createJsonResponse({});
  }) as typeof fetch;

  try {
    const manager = createBuildingDetailsManager();
    manager.selectBuilding({
      osmType: 'way',
      osmId: 21,
      lon: 37.6,
      lat: 55.75,
      featureKind: 'building'
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const loadedState = get(manager) as any;
    assert.equal(loadedState.buildingDetails?.review_status, 'pending');
    assert.equal(loadedState.buildingDetails?.user_edit_id, 41);
    assert.equal(loadedState.buildingDetails?.admin_comment, 'Needs review');

    await manager.saveEdit({
      osmType: 'way',
      osmId: 21,
      name: 'Pending House',
      style: 'art-deco',
      material: 'brick',
      colour: '#222222',
      levels: '4',
      yearBuilt: '1999',
      architect: 'Alice',
      address: 'Main street, 21',
      archimapDescription: 'Waiting for moderation',
      editedFields: ['style']
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const latestState = get(manager) as any;
    assert.equal(latestState.buildingDetails?.review_status, 'pending');
    assert.equal(latestState.buildingDetails?.user_edit_id, 41);
    assert.equal(latestState.buildingDetails?.properties?.archiInfo?.styleRaw, 'art-deco');

    const postRequest = requests.find((request) => request.method === 'POST' && request.url.endsWith('/api/building-info'));
    assert.equal(postRequest?.body?.editedFields?.[0], 'style');

    manager.destroy();
  } finally {
    clearSelectedBuildings();
    session.set({
      loading: false,
      authenticated: false,
      csrfToken: null,
      user: null
    });
    global.fetch = originalFetch;
  }
});
