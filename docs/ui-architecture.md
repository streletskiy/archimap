# UI Architecture

## Purpose

This document is the working instruction for building and maintaining the ArchiMap interface.

The frontend UI stack is:

- `SvelteKit`
- `Tailwind CSS v4`
- `shadcn-svelte`
- `Bits UI`

The goal of this stack is not to redesign ArchiMap around upstream demos. The goal is to keep the existing ArchiMap palette, shell composition, dialogs, panels, and page structure while standardizing controls, interaction contracts, and shared styling rules.

## Architecture Layers

1. `frontend/src/lib/components/ui/**`
   Generated `shadcn-svelte` primitives. Keep these close to upstream. Regenerate from the official registry when possible instead of manually diverging from upstream component structure.

2. `frontend/src/lib/components/base/**`
   Project wrappers around generated primitives. Product code must import shared controls from here, not from `ui/**`.

3. `frontend/src/lib/components/shell/**` and route components
   Application composition layer. Dialogs, portal windows, map shells, admin sections, profile pages, and page-level compositions belong here.

4. `frontend/src/app.css`
   The shared design-system contract. Semantic classes, palette tokens, elevations, borders, radii, surface styles, and shared layout contracts live here.

## Non-Negotiable Rules

1. Product and shell code must import controls from `$lib/components/base`.
2. Direct imports from `frontend/src/lib/components/ui/**` are allowed only inside `frontend/src/lib/components/base/**`.
3. `frontend/src/app.css` is the source of truth for shared UI styling. Do not duplicate long Tailwind state chains across many components when the pattern is shared.
4. New UI work must preserve existing page, panel, and modal structure unless the redesign is explicitly planned.
5. The ArchiMap palette stays authoritative. Upstream `shadcn-svelte` defaults do not replace ArchiMap colors.
6. Tailwind theme customization belongs in CSS tokens and semantic classes, not in a reintroduced legacy Tailwind config.
7. If a shared control pattern appears in more than one feature area, extract it into the base layer or into a semantic layout contract in `app.css`.

## Styling Source Of Truth

- Use `@theme inline` in `frontend/src/app.css` to map `shadcn-svelte` semantic tokens onto ArchiMap colors.
- Keep light and dark themes compatible with the existing `html[data-theme='light|dark']` model.
- Shared control visuals should be expressed through semantic classes such as `ui-button`, `ui-input`, `ui-select-trigger`, `ui-tabs-trigger`, `ui-table-*`, `ui-switch`, and `ui-label`.
- Use local utilities for one-off layout adjustments. Use semantic classes when the pattern is shared or repeated.

## Base Components

Current project-level shared controls:

- `UiButton`
- `UiCheckbox`
- `UiColorPicker`
- `UiLabel`
- `UiInput`
- `UiPressableCard`
- `UiRadioGroup`
- `UiRadioGroupItem`
- `UiTextarea`
- `UiSelect`
- `UiScrollArea`
- `UiTabsNav`
- `UiBadge`
- `UiCard`
- `UiDateRangePicker`
- `UiSwitch`
- `UiTable`
- `UiTableHeader`
- `UiTableBody`
- `UiTableRow`
- `UiTableHead`
- `UiTableCell`

When a new control is needed:

1. Generate or add the primitive in `ui/**`.
2. Wrap it in `base/**`.
3. Bind it to ArchiMap tokens and semantic classes.
4. Only then use it in product code.

## Shared Interaction Patterns

### Tabs

- `UiTabsNav` may span the available row width.
- Individual tab triggers must keep intrinsic content width and must not stretch to fill all free space.

### Selects

- `UiSelect` is the default dropdown for product code.
- Standard dropdowns must not lock page scrolling when opened. Shared `Select.Content` keeps `preventScroll` disabled by default to avoid horizontal page shift on account, admin, and info surfaces.
- When a specific shell needs stronger layering, use semantic floating-layer classes from `frontend/src/app.css` such as `ui-floating-layer-user-menu`, `ui-floating-layer-map-filter`, `ui-floating-layer-date-panel`, and `ui-floating-layer-building-modal`.
- Use `size="xs"` for dense admin and filter toolbars instead of ad-hoc compact sizing classes.
- In dense rows and toolbars, selected trigger text must truncate inside the field instead of forcing the grid cell wider than its layout slot.
- `Bits UI` floating wrappers intentionally keep runtime inline styles for `position`, `transform`, available space, and anchor geometry. Those values are computed by Floating UI and must not be moved into static CSS.

### Color Selection

- `UiColorPicker` is the shared color-selection control for product code.
- It uses `shadcn-svelte` popover primitives for the shell and `svelte-awesome-color-picker` only as the internal interaction engine.
- Product code must not embed raw `input[type='color']` when the interaction is part of the application UI.
- For map filter layers, keep the trigger compact and use shared swatches plus hex input inside the popover.
- User-defined colors may use inline CSS custom properties, but only on the nearest semantic root for that colored element or component.
- Do not use raw inline presentation styles such as `style="background: ..."` in product code when the same value can be expressed through a custom property consumed by shared CSS.
- Third-party internals may still emit inline color styles in generated DOM. Treat that as library behavior, not a pattern to copy into product code.

### Filter Toolbars

- Shared filter rows on admin and account pages must use semantic toolbar layout classes from `frontend/src/app.css`.
- Each control gets its own slot.
- Dense clusters such as sort, limit, and action buttons should be grouped intentionally instead of relying on incidental flex wrapping.
- Shared filter controls should keep the same vertical rhythm: default field height for `UiInput`, `UiSelect`, `UiDateRangePicker`, and matching action button height.

### Map Filter Panel

- The map filter shell uses the same dense-control rules as the rest of the product UI.
- Tag-key selection must use the same scrollable `UiSelect` pattern as the rest of the app, not a native `datalist`.
- Option labels must keep the raw tag key visible together with the human-readable label.
- Each filter layer is a group.
- Each criterion inside a layer is its own visually separated item, not an undifferentiated raw row. The layer card defines the group; the criterion item defines the editable unit.
- Layer/rule editing UI is shared between map and admin preset management through one reusable component (`FilterLayersEditor.svelte`), and map/admin surfaces should compose it instead of duplicating layer editor markup/logic.
- Map preset buttons are runtime data-driven (`/api/filter-presets`), while admin preset labels are editable persisted data with per-locale `nameI18n` values (not locale keys).

### Date Range

- `UiDateRangePicker` is the standard date-range filter for edit history and moderation history views.
- It wraps `shadcn-svelte` `Range Calendar` and keeps the ArchiMap event contract intact.

### Tables

- `UiTable*` is the default table stack for product code.
- Native `<table>` markup should remain only inside generated upstream primitives or content-rendering cases that are not part of product UI composition.

### Scrollable Areas

- `UiScrollArea` is the default wrapper for long panes and lists such as search results, diff panes, OSM tag dumps, and admin region lists.

### Pressable Cards

- `UiPressableCard` is the default full-surface selectable card for richer list rows that are more complex than a button.

### Auth Surface

- Login and registration reuse the current `shadcn-svelte` block structure derived from `login-04` and `signup-04`.
- Auth mode switches must not change modal width or visual-pane dimensions.
- The right-side visual keeps the project-specific blurred map treatment rather than upstream demo art.
- Registration uses a single footer legal note and standard required-field markers instead of per-field `required/optional` labels and inline consent checkboxes.
- Guest navigation exposes a single combined auth action: `Sign in / Register`.

## Event And API Conventions

- For `base/**` controls, prefer Svelte 5 callback props such as `onclick`, `oninput`, and `onchange`.
- For generated `ui/**` primitives, use their semantic callback props when they exist. Example: `onCheckedChange` on `Switch`.
- `UiSelect` and `UiTabsNav` keep the existing app-level semantic `onchange` contract via `{ detail: { ... } }`.
- Do not add new `on:` forwarding layers inside shared base controls unless there is a concrete compatibility reason.
- Plain DOM event listeners in feature components are acceptable when they are local to that component and not part of a shared control contract.

## Route-Level Rules

### Map Route URL State

- URL-state application and URL-state syncing on the map route must start only after `onMount`.
- The map route must not subscribe to `$page` just to observe query-string changes.
- The URL-state controller reads `window.location.href` directly and reacts to browser `popstate`.
- This avoids rerender churn in portal-heavy UI such as building dialogs, selects, and other portaled overlays.

### Shell And Page Composition

- Shell components define application composition and shared UX language.
- Routes should stay thin when possible and delegate behavior to shell components, services, and stores.
- Base controls define the contract; shells define composition; routes wire data and lifecycle.

## Workflow For New UI Work

1. Check whether an existing base component already solves the problem.
2. If not, generate or add the primitive in `ui/**`.
3. Wrap it in `base/**`.
4. Map shared styling into semantic classes and tokens in `frontend/src/app.css`.
5. Migrate feature code to the base wrapper.
6. Update this document if a new shared pattern or rule was introduced.

## Build And Verification

During UI development, the minimum required checks are:

- `npm run frontend:check`
- `npm run lint`
- `npm run frontend:build`

Before considering a UI change complete, also run the broader verification contour when the change affects behavior or shared primitives:

- `npm run test`
- `npm run test:e2e`

For local development:

- `npm run dev`

For frontend-only production build verification:

- `npm run frontend:build`

## Review Checklist

Before merging UI work, verify the following:

- Product code does not import `ui/**` directly.
- Shared styling was not duplicated into long repeated class chains without reason.
- Palette and surface treatment remain consistent with ArchiMap.
- Existing page and modal structure was preserved unless intentionally redesigned.
- Shared controls keep consistent heights, spacing, and event contracts.
- Portaled dropdowns and dialogs do not introduce stacking or layout-shift regressions.
- The required checks and tests were run successfully.
