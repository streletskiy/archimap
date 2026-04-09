This directory contains a local mirror of the Protomaps sprite atlas and glyph PBFs used by the custom basemap style.

Mirrored files:

- `sprites/v4/light*.json|png`
- `sprites/v4/dark*.json|png`
- `fonts/Noto Sans Regular/{0-255,256-511,1024-1279}.pbf`
- `fonts/Noto Sans Medium/{0-255,256-511,1024-1279}.pbf`
- `fonts/Noto Sans Italic/{0-255,256-511,1024-1279}.pbf`

Runtime compatibility:

- The built app copies this directory into `frontend/build/client/basemaps-assets`.
- The custom Protomaps basemap serves glyphs through `/api/basemaps/glyphs/{fontstack}/{range}.pbf`, backed by files from this directory.
- For compatibility the server also answers legacy `/basemaps-assets/fonts/{fontstack}/{range}.pbf` requests.
- `Open Sans Bold|Regular|Italic` requests are aliased to the matching local `Noto Sans Medium|Regular|Italic` glyph sets so overlay symbol layers do not 404 against the local glyph bundle.

If you need more glyph coverage for other scripts, add the required `{fontstack}/{range}.pbf` files here and keep the same path layout.
