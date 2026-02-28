# Security Policy

## Supported Versions

Security fixes are applied to the latest `main`/`master` branch.

## Reporting a Vulnerability

1. Do not open a public GitHub issue for sensitive vulnerabilities.
2. Send a private report to project maintainers with:
   - affected version/commit SHA,
   - reproduction steps,
   - impact assessment,
   - suggested mitigation (optional).
3. Maintainers will acknowledge within 7 days and provide a remediation plan.

## Operational Security Notes

- Set `SESSION_SECRET` to a strong random value in production.
- Set `APP_BASE_URL` in production (used in password-reset and registration links).
- Keep `SESSION_ALLOW_MEMORY_FALLBACK=false` in production.
- Keep dependencies updated (`Dependabot`, `npm audit`, `CodeQL` are configured in CI).
