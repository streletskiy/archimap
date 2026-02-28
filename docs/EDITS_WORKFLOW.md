# Edits Workflow

User-side:

- Bootstrap rule:
  - first registered user is created immediately as `is_admin=1` and `is_master_admin=1` (no email confirmation required).
  - this bootstrap registration is available even when `REGISTRATION_ENABLED=false` and SMTP is not configured.
- User submits building changes via `POST /api/building-info`.
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

Corner cases handled:

- Parallel admin moderation:
  - optimistic lock: merge/reject updates are allowed only when `status='pending'`.
- Stale edit merge:
  - merge returns `409 EDIT_OUTDATED` when local building data changed after edit creation (unless `force=true`).
- Multiple edits from one user for same building:
  - only one active `pending`, old duplicate pendings become `superseded`.
- Multiple users editing same building:
  - each user has independent edit rows; admin resolves conflicts during moderation/merge.

Map visibility rules:

- User map overlays own `pending` and `rejected` edits.
- `accepted` and `partially_accepted` are already merged into local shared dataset.
