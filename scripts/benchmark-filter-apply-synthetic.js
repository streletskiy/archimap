/* global requestAnimationFrame, window */

const path = require('path');
const { chromium } = require('playwright');

const VIEWPORT = { width: 1440, height: 900 };
const CAMERA = {
  lat: 55.753541,
  lng: 37.626961,
  z: 13.11
};
const FEATURE_COUNT = 15000;
const HIGHLIGHT_COLOR = '#f59e0b';
const SAMPLES = 7;
const WARMUPS = 1;

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return Number(sortedValues[index].toFixed(2));
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    min: Number(sorted[0]?.toFixed(2) || 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: Number(sorted[sorted.length - 1]?.toFixed(2) || 0),
    avg: Number(avg.toFixed(2)),
    samples: values.map((value) => Number(value.toFixed(2)))
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    await page.setContent(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <style>
            html, body, #map {
              margin: 0;
              width: 100%;
              height: 100%;
              overflow: hidden;
            }
          </style>
        </head>
        <body>
          <div id="map"></div>
        </body>
      </html>
    `);

    await page.addStyleTag({
      path: path.join(process.cwd(), 'frontend', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.css')
    });
    await page.addScriptTag({
      path: path.join(process.cwd(), 'frontend', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.js')
    });

    const setup = await page.evaluate(async ({ camera, featureCount, color, samples, warmups }) => {
      const EMPTY_FILTER = ['==', ['id'], -1];
      const SOURCE_ID = 'synthetic-buildings';
      const BASE_FILL_ID = 'synthetic-base-fill';
      const BASE_LINE_ID = 'synthetic-base-line';
      const FS_FILL_ID = 'synthetic-fs-fill';
      const FS_LINE_ID = 'synthetic-fs-line';
      const V1_FILL_ID = 'synthetic-v1-fill';
      const V1_LINE_ID = 'synthetic-v1-line';
      const V2_FILL_ID = 'synthetic-v2-fill';
      const V2_LINE_ID = 'synthetic-v2-line';
      const V3_FILL_ID = 'synthetic-v3-fill';
      const V3_LINE_ID = 'synthetic-v3-line';

      function waitFrames(frameCount = 2) {
        return new Promise((resolve) => {
          let remaining = Math.max(1, Number(frameCount) || 1);
          const tick = () => {
            remaining -= 1;
            if (remaining <= 0) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }

      function buildColorExpression(ids, fillColor) {
        return ['match', ['id'], ids, fillColor, 'transparent'];
      }

      function buildActiveExpression(ids, activeValue, inactiveValue) {
        return ['match', ['id'], ids, activeValue, inactiveValue];
      }

      function buildFilterExpression(ids) {
        return ['in', ['id'], ['literal', ids]];
      }

      function generateFeatureCollection(bounds, count) {
        const south = Number(bounds.getSouth());
        const west = Number(bounds.getWest());
        const north = Number(bounds.getNorth());
        const east = Number(bounds.getEast());
        const width = east - west;
        const height = north - south;
        const columns = 150;
        const rows = Math.ceil(count / columns);
        const cellWidth = width / columns;
        const cellHeight = height / rows;
        const polygonWidth = cellWidth * 0.62;
        const polygonHeight = cellHeight * 0.62;
        const marginX = (cellWidth - polygonWidth) / 2;
        const marginY = (cellHeight - polygonHeight) / 2;
        const features = [];

        for (let index = 0; index < count; index += 1) {
          const column = index % columns;
          const row = Math.floor(index / columns);
          const left = west + (column * cellWidth) + marginX;
          const right = left + polygonWidth;
          const bottom = south + (row * cellHeight) + marginY;
          const top = bottom + polygonHeight;
          features.push({
            type: 'Feature',
            id: index + 1,
            properties: {
              osm_key: `way/${index + 1}`,
              osm_type: 'way',
              osm_id: index + 1,
              kind: 'synthetic'
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [left, bottom],
                [right, bottom],
                [right, top],
                [left, top],
                [left, bottom]
              ]]
            }
          });
        }

        return {
          type: 'FeatureCollection',
          features
        };
      }

      const map = new window.maplibregl.Map({
        container: 'map',
        center: [camera.lng, camera.lat],
        zoom: camera.z,
        hash: false,
        attributionControl: false,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: 'background',
              type: 'background',
              paint: {
                'background-color': '#f5f5f4'
              }
            }
          ]
        }
      });

      await new Promise((resolve) => map.once('load', resolve));
      const bounds = map.getBounds();
      const featureCollection = generateFeatureCollection(bounds, featureCount);
      const ids = featureCollection.features.map((feature) => Number(feature.id));

      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: featureCollection
      });

      map.addLayer({
        id: BASE_FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': '#d6d3d1',
          'fill-opacity': 0.45
        }
      });
      map.addLayer({
        id: BASE_LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': '#78716c',
          'line-width': 0.5,
          'line-opacity': 0.7
        }
      });

      map.addLayer({
        id: FS_FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            ['to-color', ['feature-state', 'filterColor']],
            'transparent'
          ],
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.4,
            0
          ]
        }
      });
      map.addLayer({
        id: FS_LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            ['to-color', ['feature-state', 'filterColor']],
            'transparent'
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            1.8,
            0
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.95,
            0
          ]
        }
      });

      map.addLayer({
        id: V1_FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': 'transparent',
          'fill-opacity': 0
        }
      });
      map.addLayer({
        id: V1_LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': 'transparent',
          'line-width': 0,
          'line-opacity': 0
        }
      });

      map.addLayer({
        id: V2_FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        filter: EMPTY_FILTER,
        paint: {
          'fill-color': 'transparent',
          'fill-opacity': 0
        }
      });
      map.addLayer({
        id: V2_LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: EMPTY_FILTER,
        paint: {
          'line-color': 'transparent',
          'line-width': 0,
          'line-opacity': 0
        }
      });

      map.addLayer({
        id: V3_FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        filter: EMPTY_FILTER,
        paint: {
          'fill-color': 'transparent',
          'fill-opacity': 0
        }
      });
      map.addLayer({
        id: V3_LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: EMPTY_FILTER,
        paint: {
          'line-color': 'transparent',
          'line-width': 0,
          'line-opacity': 0
        }
      });

      await waitFrames(4);

      async function clearFeatureState() {
        for (const id of ids) {
          map.setFeatureState(
            { source: SOURCE_ID, id },
            { isFiltered: false, filterColor: '#000000' }
          );
        }
        await waitFrames(3);
      }

      async function applyFeatureStateChunked() {
        const chunkSize = 540;
        const denseThreshold = 1200;
        const totalOps = ids.length;
        const denseMode = totalOps >= denseThreshold;
        const frameBudgetMs = denseMode ? 8.5 : 4.5;
        const maxOpsPerFrame = denseMode ? 2800 : chunkSize;
        let index = 0;

        while (index < ids.length) {
          const frameStartedAt = performance.now();
          let frameOps = 0;
          while (
            frameOps < maxOpsPerFrame &&
            index < ids.length &&
            (performance.now() - frameStartedAt) <= frameBudgetMs
          ) {
            map.setFeatureState(
              { source: SOURCE_ID, id: ids[index] },
              { isFiltered: true, filterColor: color }
            );
            index += 1;
            frameOps += 1;
          }
          if (index < ids.length) {
            await waitFrames(1);
          }
        }
        await waitFrames(3);
      }

      async function clearPaintV1() {
        map.setPaintProperty(V1_FILL_ID, 'fill-color', 'transparent');
        map.setPaintProperty(V1_FILL_ID, 'fill-opacity', 0);
        map.setPaintProperty(V1_LINE_ID, 'line-color', 'transparent');
        map.setPaintProperty(V1_LINE_ID, 'line-width', 0);
        map.setPaintProperty(V1_LINE_ID, 'line-opacity', 0);
        await waitFrames(3);
      }

      async function applyPaintV1() {
        const colorExpression = buildColorExpression(ids, color);
        map.setPaintProperty(V1_FILL_ID, 'fill-color', colorExpression);
        map.setPaintProperty(V1_FILL_ID, 'fill-opacity', buildActiveExpression(ids, 0.4, 0));
        map.setPaintProperty(V1_LINE_ID, 'line-color', colorExpression);
        map.setPaintProperty(V1_LINE_ID, 'line-width', buildActiveExpression(ids, 1.8, 0));
        map.setPaintProperty(V1_LINE_ID, 'line-opacity', buildActiveExpression(ids, 0.95, 0));
        await waitFrames(3);
      }

      async function clearPaintV2() {
        map.setFilter(V2_FILL_ID, EMPTY_FILTER);
        map.setFilter(V2_LINE_ID, EMPTY_FILTER);
        map.setPaintProperty(V2_FILL_ID, 'fill-color', 'transparent');
        map.setPaintProperty(V2_FILL_ID, 'fill-opacity', 0);
        map.setPaintProperty(V2_LINE_ID, 'line-color', 'transparent');
        map.setPaintProperty(V2_LINE_ID, 'line-width', 0);
        map.setPaintProperty(V2_LINE_ID, 'line-opacity', 0);
        await waitFrames(3);
      }

      async function applyPaintV2() {
        const normalizedGroups = [{ color, ids }];
        buildColorExpression(ids, color);
        const activeIds = normalizedGroups.flatMap((group) => group.ids);
        const filterExpression = buildFilterExpression(activeIds);
        map.setFilter(V2_FILL_ID, filterExpression);
        map.setFilter(V2_LINE_ID, filterExpression);
        map.setPaintProperty(V2_FILL_ID, 'fill-color', color);
        map.setPaintProperty(V2_FILL_ID, 'fill-opacity', 0.4);
        map.setPaintProperty(V2_LINE_ID, 'line-color', color);
        map.setPaintProperty(V2_LINE_ID, 'line-width', 1.8);
        map.setPaintProperty(V2_LINE_ID, 'line-opacity', 0.95);
        await waitFrames(3);
      }

      async function clearPaintV3() {
        map.setFilter(V3_FILL_ID, EMPTY_FILTER);
        map.setFilter(V3_LINE_ID, EMPTY_FILTER);
        map.setPaintProperty(V3_FILL_ID, 'fill-color', 'transparent');
        map.setPaintProperty(V3_FILL_ID, 'fill-opacity', 0);
        map.setPaintProperty(V3_LINE_ID, 'line-color', 'transparent');
        map.setPaintProperty(V3_LINE_ID, 'line-width', 0);
        map.setPaintProperty(V3_LINE_ID, 'line-opacity', 0);
        await waitFrames(3);
      }

      async function applyPaintV3() {
        const filterExpression = ['in', ['id'], ['literal', ids]];
        map.setFilter(V3_FILL_ID, filterExpression);
        map.setFilter(V3_LINE_ID, filterExpression);
        map.setPaintProperty(V3_FILL_ID, 'fill-color', color);
        map.setPaintProperty(V3_FILL_ID, 'fill-opacity', 0.4);
        map.setPaintProperty(V3_LINE_ID, 'line-color', color);
        map.setPaintProperty(V3_LINE_ID, 'line-width', 1.8);
        map.setPaintProperty(V3_LINE_ID, 'line-opacity', 0.95);
        await waitFrames(3);
      }

      function getRoundRobinModes(modes, roundIndex) {
        const offset = roundIndex % Math.max(1, modes.length);
        return [
          ...modes.slice(offset),
          ...modes.slice(0, offset)
        ];
      }

      async function benchmarkModes(modes) {
        const samplesByName = new Map(modes.map((mode) => [mode.name, []]));

        for (let warmupIndex = 0; warmupIndex < warmups; warmupIndex += 1) {
          for (const mode of getRoundRobinModes(modes, warmupIndex)) {
            await mode.clear();
            await mode.apply();
          }
        }

        for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
          for (const mode of getRoundRobinModes(modes, sampleIndex + warmups)) {
            await mode.clear();
            const startedAt = performance.now();
            await mode.apply();
            samplesByName.get(mode.name).push(performance.now() - startedAt);
          }
        }

        for (const mode of modes) {
          await mode.clear();
        }

        return modes.map((mode) => ({
          name: mode.name,
          samples: samplesByName.get(mode.name) || []
        }));
      }

      const results = await benchmarkModes([
        { name: 'feature-state-chunked', apply: applyFeatureStateChunked, clear: clearFeatureState },
        { name: 'paint-expression-v1', apply: applyPaintV1, clear: clearPaintV1 },
        { name: 'paint-expression-v2-before-hotpath-opt', apply: applyPaintV2, clear: clearPaintV2 },
        { name: 'paint-expression-v3-after-hotpath-opt', apply: applyPaintV3, clear: clearPaintV3 }
      ]);

      return {
        camera,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        featureCount: ids.length,
        results
      };
    }, {
      camera: CAMERA,
      featureCount: FEATURE_COUNT,
      color: HIGHLIGHT_COLOR,
      samples: SAMPLES,
      warmups: WARMUPS
    });

    const report = {
      camera: setup.camera,
      viewport: setup.viewport,
      featureCount: setup.featureCount,
      benchmark: Object.fromEntries(setup.results.map((entry) => [entry.name, summarize(entry.samples)]))
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
