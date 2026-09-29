# S04c operator UI evidence

## Source and automated checks

- Planned base: `95878b7ce7cc04e7a203133a4752c0292dcb9c3f`; issue #703 plan revision 1.
- Runtime: Node `24.21.0`; npm `12.1.0`.
- Browser test dependency: Playwright `1.63.0`; installed Chromium `153.0.8010.12`.
- `npm ci --no-audit --no-fund`: passed.
- `npm run check`: passed after repairs; typecheck, lint, format, build and 91 tests passed, including the Chromium operator journey.
- The Chromium journey uses a marked `StandaloneService` fixture and real SQLite; it proves unauthenticated protected-URL login, independent login/session rotation, guarded origin/CSRF failures, shared-profile projects with separate instructions across service/SQLite restart, paused-project and unready-task defaults, Ready without pause bypass, secret-safe routing views, and browser logout/session invalidation.
- `test/s04c/private-access.mjs` is opt-in (`--live`), requires a canonical HTTPS fixture origin plus a pre-seeded private project ID/marker, prompts for the fixture password without echo, suppresses response/error contents, refuses cross-origin navigation before typing a password, checks unauthenticated read/write denial, `Secure` cookie behavior and guarded writes, performs one same-origin configuration write, and attempts browser logout in `finally`.

## Bounded private-access proof

**Status: UNPROVED — required evidence is missing; do not claim #703 complete.**

Read-only inspection found Tailscale CLI `1.102.4` (commit
`bbcd7d1fc2054b9189ebc1531acf74bd880ca0c8`) connected to daemon `1.102.2`
(commit `t6cac91817-g6ff0ddc72`); the client/server versions do not match.
`tailscale serve status` reported `No serve config`. The current host is a
personal workstation, not an identified disposable node. No disposable
node/socket or second approved peer was designated, so no peer was contacted,
no listener or Serve/Funnel configuration was changed, and no fixture was
created. There was nothing to clean up from this work. A final read-only retry
of `tailscale serve status --json` and `tailscale funnel status --json` could
not reach `/var/run/tailscaled.socket`, so current Serve/Funnel state could not
be reverified. No claim is made about the final state of that personal host.

The unproved prerequisites are one specifically approved disposable node/socket
with no existing Serve mapping and one specifically approved second tailnet
peer. The live observation must confirm that requests to the configured HTTPS
FQDN reach the loopback listener with the expected `Host`, that no Funnel/public
route is enabled, and that the independent Ensemble login, CSRF and private data
boundary work from that second peer.

Once those exact disposable identities are approved, the bounded procedure is:

1. On the disposable node only, create a fresh service data directory and a
   separate mode-`0600` auth file. Set
   `ENSEMBLE_OPERATOR_ORIGIN=https://<disposable-node-fqdn>` (include a
   non-default HTTPS port if one is used) and
   `ENSEMBLE_OPERATOR_AUTH_FILE=<absolute-private-auth-file>`. Start the
   operator on a chosen fixture port; it must listen only on
   `127.0.0.1:<fixture-port>`.
2. Read `tailscale serve status --json` and `tailscale funnel status --json`
   before exposure. Proceed only if this dedicated node has no existing Serve
   or Funnel configuration. Enable only the planned listener:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:<fixture-port>
   tailscale serve status --json
   tailscale funnel status --json
   ```

3. From the specifically approved second peer, set
   `ENSEMBLE_TEST_HTTPS_ORIGIN=https://<disposable-node-fqdn>`,
   `ENSEMBLE_TEST_PROJECT_ID=<pre-seeded-private-project-id>`, and
   `ENSEMBLE_TEST_PRIVATE_MARKER=<pre-seeded-private-project-name>`, then run
   `node test/s04c/private-access.mjs --live`. Do not put the password in argv
   or environment; enter it only at the hidden prompt. Record the exact
   disposable node and peer identities in the authorized handoff, not in a
   public source file.
4. In a `finally` path on that disposable node, disable only this HTTPS mapping
   with `tailscale serve --bg --https=443 off`, then read
   `tailscale serve status --json` and require no remaining Serve configuration.
   Stop the fixture service, log out, and remove only its temporary data/auth
   files. Confirm the disposable node has no Funnel mapping and that its prior
   Serve state was empty. Never run these mutations on the current workstation
   or a shared node.

The loopback server accepts the exact configured host or its actual
`127.0.0.1:<fixture-port>` listener host; it does not trust forwarded headers.
The browser `Origin` must exactly equal the configured HTTPS origin. The planned
Serve URL is HTTPS on port 443 to the loopback HTTP listener, so the browser
origin/Host expectation is the disposable node's HTTPS FQDN (without a trailing
slash or `:443`). Any observed Host mismatch or non-empty pre-existing Serve or
Funnel state stops the proof before mutation.
