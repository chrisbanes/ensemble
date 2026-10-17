# #1145 browser notifications: host-browser check — 2026-10-17

## Outcome

Passed one bounded live run of `node test/operator/push-qualification/live-push.mjs --live`
against the real Chrome push service on the maintainer's Mac. A fresh Chrome profile
turned notifications on, received a test notification, one question notification and
one runtime notification through `fcm.googleapis.com`, did not receive a duplicate or
a push for a resolved request, saw both notifications close when their requests left
the Inbox, and, after unsubscribing in the browser, got `410` from the push service,
which revoked the row as removed by the push service. It does not qualify a phone or
any other device, the operating system's own notification click, Safari, or a real
crashed runtime.

## Identity

- Harness: `test/operator/push-qualification/live-push.mjs`, Node v24.22.0, Playwright 1.64.1.
- Browser: the installed Google Chrome 155.0.8059.80 (user agent `Chrome/155.0.0.0`),
  headed, macOS (Darwin, Apple silicon), a fresh temporary profile created with
  `launchPersistentContext` and removed after the run, with `--disable-background-networking`
  left out of Playwright's default arguments so Chrome can reach its push service.
- Service: the disposable operator fixture (real operator UI, notifier, SQLite and
  service worker; a fake runtime, so no model turn) on an ephemeral `127.0.0.1` port with
  temporary data and auth directories, removed after the run. The real `fetchPushTransport`
  sent every push. The installed Ensemble service, its port, state and auth file, the
  user's own browser profile and every credential were not touched.
- Code: branch `cb/issue-1145-web-push` at commit `50116190` (`main` at `7eb44177` merged in), the commit before this record. Later commits change only the partial-read baseline limit, the shared Inbox link builder, a send-time host re-check and failure copy; the live steps were not re-run for them.

## Steps and results

Timings are from the final run (the fourth; the earlier three found the harness problems listed under Findings), in milliseconds.

| Step | Result |
| --- | --- |
| Sign in | Passed through the context's request API (see Findings). |
| 1 Real subscribe | Passed in 49,818 ms (Chrome's first registration with its push service in a fresh profile took 25–50 s in every run). Push service host `fcm.googleapis.com`, in the allowlist. |
| 2 Test notification | The push service answered `201`; the notification was listed by `registration.getNotifications()` 7 ms later. |
| 3 One question | After one tick the push service answered `201` and the notification was listed after 507 ms (tick to shown, 579 ms). Its title read "Question in <project>: 1 waiting" and did not contain the question text. |
| 4 Second tick | No push request and still one notification with that tag. |
| 5 Click | Not proven end to end. In Chrome's own worker, `clients.matchAll` found the controlled `/app` window and `navigate()` took it to the exact `/app/inbox?task=…&request=…` link. `focus()` was refused (`InvalidAccessError`) and `openWindow` cannot run without a real click, so focus, `openWindow` and the operating system's delivery of a click are untested here. The handler's branches are covered by `operator-push-service-worker.test.ts` against a fake scope. |
| 6 Answer the question | No further push (request count unchanged). After a page reload the Inbox read closed the notification (`getNotifications()` no longer listed its tag). |
| 7 Runtime exhaustion | A fake runtime that fails every start, on an injected restart clock, exhausted: one push (`201`), one "Codex runtime unavailable" notification listed within a few milliseconds, no duplicate on the next tick. Re-enabling the runtime closed the notification after the next Inbox read. |
| 8 Unsubscribe, then test | After `PushSubscription.unsubscribe()` in the browser alone, the first test still answered `201`; the second, 5 s later, answered `410`, the outcome was "gone" and the row read revoked as removed by the push service. The push service forgets an unsubscribed registration a few seconds late, so the harness repeats the test up to 24 times at 5 s intervals. |
| 9 Secrets | The harness transcript and result contain neither the private key nor the question text. The private key appears in no file except `operator-push-vapid.json`, and the `operator_push_*` tables hold no private key, no question text and, after the revocation, no endpoint. |

Chrome's notifications were observed through `registration.getNotifications()`, not as
banners in the macOS Notification Center, so the operating system's own display of a
notification, and any macOS-level permission for Chrome, were not checked.

## Findings

- Chrome refuses push registration in off-the-record contexts ("Registration failed -
  permission denied"), which is what Playwright's default `newContext()` creates, so the
  harness uses a persistent context over a fresh temporary profile. Playwright's headless
  Chromium has the same limit in the other direction: it cannot receive push, so the browser
  test in `operator-notifications-browser.test.ts` stubs `PushManager` and proves the page,
  registration and routes, not push delivery.
- The operator sign-in form failed under this Chrome with a CSRF `403`: Chrome's own
  `/favicon.ico` request reaches a legacy route (`authorizeRead`) that starts a second
  anonymous session and replaces the session cookie, so the token the page holds no longer
  matches. Reloading the page signs in. This is unrelated to push and unchanged here; the
  harness signs in through the context's request API, which shares the cookie jar.
- Phone and other-device delivery is not qualified ([#1150](https://github.com/chrisbanes/ensemble/issues/1150)).
  Runtime exhaustion was driven by a fake runtime, not a crashed real App Server.
