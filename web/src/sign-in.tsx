import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Session } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button, TextField } from "./components.js";
import { Alert } from "./ui/alert.js";

/** Bootstrap states share the sign-in layout; neither is a designed screen. */
export function SignInBootstrap({
  unavailable,
  retry,
}: {
  unavailable: boolean;
  retry: () => void;
}) {
  return (
    <main className="login">
      <div className="login-content">
        <h1 className="page-heading">Ensemble</h1>
        {unavailable ? (
          <>
            <p role="alert" className="body">
              Sign-in service unavailable.
            </p>
            <Button onClick={retry}>Try again</Button>
          </>
        ) : (
          <p role="status" className="body">
            Loading sign-in…
          </p>
        )}
      </div>
    </main>
  );
}

/** The sign-in screen, also the entry after an in-page expiry (`expired`). */
export function Login({
  client,
  session,
  onSignedIn,
  expired = false,
}: {
  client: OperatorClient;
  session: Session;
  onSignedIn: (s: Session) => void;
  expired?: boolean;
}) {
  const [password, setPassword] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // A failure clears the field; return focus to it once it is enabled again.
  useEffect(() => {
    if (error && !pending) input.current?.focus();
  }, [error, pending]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(false);
    try {
      onSignedIn(await client.login(password, session.csrfToken));
      setPassword("");
    } catch {
      // One message for every failure: it must not reveal account or lockout detail.
      setError(true);
      setPassword("");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login">
      <div className="login-content">
        <p className="wordmark">Ensemble</p>
        <div className="login-heading">
          <h1 className="page-heading">Sign in</h1>
          <p className="introduction muted">Your operator workspace.</p>
        </div>
        {expired && (
          <Alert className="login-notice">
            <p className="body">Your session expired. Sign in to continue.</p>
            <p className="body">Private state cleared</p>
            <p className="metadata muted">
              Unsent local drafts and private reading/navigation state were
              cleared under the existing session rules. Unfinished task input is
              offered for recovery on this device.
            </p>
          </Alert>
        )}
        <form onSubmit={submit}>
          <TextField
            ref={input}
            label="Password"
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={pending}
            aria-invalid={error || undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error && (
            <p id={errorId} className="body login-error" role="alert">
              Sign in failed. Try again.
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
