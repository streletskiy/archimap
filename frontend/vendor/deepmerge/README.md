# Patched deepmerge

Vendored from the npm `deepmerge@4.3.1` distribution (MIT; see LICENSE).
The bundled CommonJS implementation and type declarations preserve its API.

GHSA-gcqx-w48m-w2h4 has no upstream patched release as of 2026-10-30.
This copy rejects `__proto__`, `constructor`, and `prototype` when copying both
target and source objects, including null-prototype objects and enumerable own
properties. This prevents assignment to the destination prototype setter.

The frontend npm override applies this patch to the Svelte Vite plugin. Remove
the override and this directory when an upstream fixed release is available.
