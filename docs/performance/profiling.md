# Profiling

## Node CPU profile

1. Start server with inspector/profile:
   - `node --cpu-prof server.js`
2. Reproduce workload (`npm run perf:smoke` or realistic traffic).
3. Open generated `.cpuprofile` in Chrome DevTools Performance panel.

## Node heap/memory

1. Start with:
   - `node --inspect server.js`
2. Connect via `chrome://inspect`.
3. Capture heap snapshot before and after high-volume bbox/search requests.

## Flamegraph (clinic)

1. Install once:
   - `npm i -D clinic`
2. Run:
   - `npx clinic flame -- node server.js`
3. Exercise routes, stop process, inspect report.

## Browser profiling

1. Open app in Chromium.
2. DevTools Performance recording:
   - pan/zoom map
   - run search modal queries
   - switch theme
3. Inspect main-thread time:
   - scripting around style switch
   - map paint/recalculate phases
   - network waterfall for `filter-data-bbox` and PMTiles range reads
