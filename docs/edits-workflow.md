# Edits Workflow

User-side:

- User submits building changes via `POST /api/building-info`.
- Supported editable fields: `name`, `style`, `material`, `colour`, `levels`, `yearBuilt`, `architect`, `address`, `archimapDescription`.
- `material` accepts the concrete variants `concrete_panels`, `concrete_blocks`, and `concrete_monolith` in addition to the regular material list.
- Bulk edit is started with Shift+Click on the map to build a temporary multi-selection.
- On the main map, Shift is reserved for bulk selection, so the default MapLibre Shift-drag box zoom is disabled there.
- The building modal stays open during map editing and does not block clicks on the map, so you can keep adding or removing buildings while the panel is open.
- The selected-building count is shown inside the building modal header; there is no separate top-of-map bulk-selection chip.
- In bulk edit mode, `name` and address tags are read-only and are not sent to the save endpoint.
- In bulk edit mode, the modal hides single-building metadata that no longer has a clear meaning for a group, such as the primary OSM id badge and the raw OSM tag dump.
- If selected buildings disagree on an editable field, the modal shows that field as mixed, lists current sample values, and leaves it unchanged until the user explicitly enters, selects, or clears a value for the whole group.
- The bulk-only `Clear for all` control writes an explicit empty value for that field to every selected building when the edit is saved.
- If any selected building is a `building_part`, bulk edit narrows the editable fields to `levels`, `colour`, `style`, `material`, and `yearBuilt`.
- When a bulk edit is submitted, the same allowed field changes are applied to every selected building one by one.
- When `material` is one of the concrete variants, the server persists `building:material=concrete` plus `building:material:concrete=<panels|blocks|monolith>` in the local merged state and user edit rows.
- For one `user + building` only one active `pending` edit is kept:
  - latest `pending` is updated in place;
  - stale extra `pending` rows are marked as `superseded`.
- In account history user can see moderation statuses and admin comment.

Admin-side moderation:

- Admin opens edit details in `/admin/` and reviews changed fields.
- Decision is field-level:
  - accept field (optionally with corrected value);
  - reject field.
- Apply action outcomes:
  - all accepted -> `accepted`;
  - accepted subset + rejected subset -> `partially_accepted`;
  - all rejected -> `rejected`.
- Accepted fields are persisted to `local.architectural_info`; merged field list is saved to `merged_fields_json`.

OSM publish flow:

- Master admins can open `Admin -> Send to OSM` and connect an OSM OAuth2 client.
- Sync works on a building group (`osm_type` + `osm_id`), not on an individual history row.
- The sync queue supports selecting multiple building groups and publishing them in one OSM changeset.
- Style edits are published as `building:architecture`.
- Before publishing, the runtime fetches the live OSM element and compares it with the stored source snapshot; if the upstream OSM state drifted, sync is blocked with `409 OSM_SYNC_SOURCE_DRIFT`.
- On success, the runtime opens an OSM changeset with a compact `comment`, `source`, and `created_by` metadata payload, pushes one or more merged element updates as standard OSM XML documents wrapped in `<osm version="0.6">`, closes the changeset, and marks all accepted / partially accepted rows for the synced building groups as `synced`.
- Changeset comments begin with `Update architectural info:` in all OSM sync cases.
- The original local history rows remain in place and carry sync metadata such as the changeset id, sync timestamps, and a compact JSON summary.
- Synced / cleaned rows are treated as read-only in admin views: they move to compact archive sections, stay collapsed by default in the UI, and cannot be re-synced or re-moderated.
- After the next successful OSM import, if the tags that were actually synchronized are already present in the imported contour data, the runtime can remove the redundant `local.architectural_info` overwrite while leaving the edit history row in compact form.

Corner cases handled:

- Parallel admin moderation:
  - optimistic lock: merge/reject updates are allowed only when `status='pending'`.
- Stale edit merge:
  - merge returns `409 EDIT_OUTDATED` when local building data changed after edit creation (unless `force=true`).
- Upstream OSM drift:
  - user edit stores OSM source snapshot (`source_tags_json`, `source_osm_updated_at`);
  - merge returns `409 EDIT_OUTDATED_OSM` when current OSM tags changed after edit creation (unless `force=true`).
- Missing OSM target:
  - merge returns `409 EDIT_TARGET_MISSING` when the original contour no longer exists;
  - admin must reassign the edit to another existing OSM object before merge.
- Orphan accepted edit:
  - accepted / partially accepted history rows remain visible in account/admin lists even if the original OSM contour disappears;
  - admin can reassign merged local data to another existing OSM object.
- Full delete by master admin:
  - `pending`, `rejected`, `superseded` edits can be removed completely from history;
  - `accepted` / `partially_accepted` can be fully deleted only when they are the only accepted edit for that OSM object;
  - in that safe case the delete removes both the history row and `local.architectural_info`;
  - if the same building already has other accepted edits, delete is blocked with `409 EDIT_DELETE_SHARED_MERGED_STATE` because merged local data is already shared.
- Multiple edits from one user for same building:
  - only one active `pending`, old duplicate pendings become `superseded`.
- Multiple users editing same building:
  - each user has independent edit rows; admin resolves conflicts during moderation/merge.

Map visibility rules:

- User map overlays own `pending` and `rejected` edits.
- `accepted` and `partially_accepted` are already merged into local shared dataset.
