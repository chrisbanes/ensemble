# S04c authenticated operator UI foundation

This document records the #703 starting boundary. Issue #694 supersedes its
statements that runtime and coordination pages are unavailable; the current
production integration and bounded evidence are described in
[`s04d-operator-integration.md`](s04d-operator-integration.md).

Issue [#703](https://github.com/chrisbanes/ensemble/issues/703) implements the
independent login, session and request boundary, a shared server-rendered shell,
and the initial project/profile/routing/local-task forms. This is a bounded
operator foundation, not the complete first-release operator UI in
[`SPEC.md`](../SPEC.md) or [`acceptance.md`](../acceptance.md). The standalone
service already provides local scheduler admission and execution supervision
through S03b; this #703 slice adds no operator scheduler controls, runtime
history, or coordination presentation. Its task forms configure readiness and
project pause, while the scheduler continues to enforce those settings.

## Login and session lifecycle

Ensemble operator credentials are independent of the Codex App Server login.
`npm run operator-auth -- init ABSOLUTE_AUTH_FILE` prompts for the password
without echoing it or putting it in argv. Initialization writes a salted scrypt
verifier, not the password, into a new same-user regular file with mode `0600`.
The auth file must be an absolute path; opening rejects symlinks, an exposed or
foreign-owned file, an oversized file, and an unsupported format. Configuration
and initialization failures are generic and do not include credential material.

The `operator` command requires `ENSEMBLE_OPERATOR_AUTH_FILE` and
`ENSEMBLE_OPERATOR_ORIGIN`. The configured origin is canonical: loopback HTTP
is limited to `127.0.0.1`, and remote origins must use HTTPS. Sessions are
process-local, so service restart invalidates them. Login rotates the anonymous
session ID and CSRF token; logout deletes the session. Idle and absolute expiry,
bounded session storage and failed-login throttling are enforced in memory.
There is one operator password, not account or role administration.

## HTTP boundary

The server binds only to `127.0.0.1`. It accepts `Host` only for that listener or
the configured origin. It does not trust `X-Forwarded-Host`, `X-Forwarded-Proto`
or other forwarded headers. Remote TLS termination and private routing are
provided by a separately managed transport such as a narrowly configured
Tailscale Serve route; this UI neither configures nor exposes a public listener.
The `Origin` on every POST, including login, must exactly equal the configured
origin. `/login` also requires the pre-login session's CSRF token. Every other
POST requires an authenticated session, the exact origin and that session's CSRF
token. Forms use URL-encoded bodies only; body, field count, key and value sizes
are bounded, duplicate fields are rejected, and malformed or unexpected input
gets a generic response.

All responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
frame/CSP restrictions, and `Referrer-Policy: same-origin`. The latter is
intentional: the Chromium native-form regression confirmed that
`no-referrer` makes Chromium submit same-origin POSTs with `Origin: null`, which
the exact-origin policy must reject. `same-origin` retains the browser's exact
Origin on native forms while suppressing referrers for cross-origin requests;
the implementation does not relax or special-case Origin validation.

The host-only session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when
the configured origin is HTTPS. Anonymous protected GETs render only the common
pre-login shell at the requested URL and set an anonymous session cookie. This
avoids a redirect-derived opaque origin on the subsequent native login POST.
After successful login the browser is redirected to `/`; no return path from
untrusted input is retained. Failed login and request errors contain no
exception, password, credential reference, session ID or submitted value, and
the adapter does not log request or form data.

## Routes and command ownership

Every built-in private view, `/command`, and registered extension route uses the
same HTTP guard. Extension routes are registered before the server starts and
cannot replace reserved login, command, project, task, profile, assignment,
runtime or coordination paths. Route handlers receive only decoded path
parameters, bounded form/query fields, and the CSRF token. They do not receive a
raw HTTP request/response object. Results are typed HTML or a same-origin local
redirect and receive the shared response headers and shell.

The HTTP `/command` allowlist is deliberately limited to
`project.create/configure`, `profile.create/configure`, `routing.configure`, and
`task.create/configure`. Assignment, dependency, imported-blocker, execution,
recovery and other #694 controls are not web commands. The underlying domain
service retains its own command contract; this allowlist is the boundary for the
operator web surface, not a duplicate domain or command implementation.

At the #703 boundary, views supported project/profile setup, routing
configuration, and local-task create/edit/read. Credential references were not
rendered back. Runtime and coordination pages, assignment history, dependency
controls and recovery presentation were unavailable. Issue #694 adds those
operator routes without changing this original slice's authentication
contract. Task readiness and configuration eligibility still do not prove
runtime admission or execution.

## Verification boundary

Service/auth and route tests use the real SQLite domain store and an ephemeral
loopback listener. Chromium exercises the protected-URL pre-login form, exact
Origin, CSRF rejection, cookie attributes, session rotation/logout/restart/
expiry, and the project/profile/routing/task create/edit/read forms. Chromium is
a test-only development dependency; CI installs its pinned engine before the
repository check.

Automated loopback tests do not prove private remote access. A separate bounded
Serve proof must record the installed Tailscale version, exact disposable node
and peer identities, actual `Host` behavior, private reachability, absence of
public exposure and exact cleanup. Do not claim Serve access as live-verified if
an approved disposable node/peer or safe cleanup path is unavailable. This
proof does not authorize deployment, route replacement, persistent Serve
configuration or a cutover.

The opt-in second-peer browser proof is
[`test/s04c/private-access.mjs`](../../test/s04c/private-access.mjs). Current
automated and unproved live evidence is recorded in
[`docs/evidence/s04c-operator-ui-2026-09-29.md`](../evidence/s04c-operator-ui-2026-09-29.md).
