import { useCallback, useId, useState, type FormEvent } from "react";
import {
  operatorCredentialNameSchema,
  type OperatorCredential,
} from "../../src/operator/contracts.js";
import {
  ActionOutcome,
  detailRows,
  type OutcomeTone,
} from "./action-feedback.js";
import { Button, StatusBadge, TextField } from "./components.js";
import { failureCause, type ReceiptDetails } from "./outcome-copy.js";
import { shortId } from "./presentation.js";
import { useOperatorResource } from "./resource.js";
import { Panel, useHeaderRefresh, type SettingsProps } from "./settings.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.js";
import { NativeSelect } from "./ui/native-select.js";

type Scope = OperatorCredential["scope"];
/** The one message a credential action leaves behind. */
interface Outcome {
  tone: OutcomeTone;
  message: string;
  details: ReceiptDetails;
  /** An unconfirmed create or rotate offers a re-read of the list, never a resend. */
  check?: boolean;
}
const lifetimes = [7, 30, 60, 90];
// A rotation keeps the name, so the short id tells the two apart.
const scopeLabel = (s: Scope) => (s === "read" ? "Read-only" : "Read-write");

export function When({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}

/** The one-time token. It lives only in this component's state and is cleared on dismiss. */
function Reveal({
  name,
  token,
  done,
}: {
  name: string;
  token: string;
  done: () => void;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Dialog open onOpenChange={(open) => !open && done()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle>CLI token for {name}</DialogTitle>
        <DialogDescription>
          Copy this token now. It will not be shown again; a lost token must be
          replaced by rotating or issuing a new credential.
        </DialogDescription>
        <code className="mono body settings-token">{token}</code>
        <div className="settings-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              navigator.clipboard.writeText(token).then(
                () => setCopy("copied"),
                () => setCopy("failed"),
              )
            }
          >
            Copy
          </Button>
          <Button type="button" onClick={done}>
            Done
          </Button>
        </div>
        <p className="metadata muted" role="status">
          {copy === "copied" && "Copied to the clipboard."}
          {copy === "failed" &&
            "Copy failed. Select the token and copy it manually."}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** CLI bearer credentials: issue, rotate and revoke from a signed-in session. */
export function OperatorCredentialsSection(p: SettingsProps) {
  const csrf = p.session.csrfToken;
  const loader = useCallback(
    (signal: AbortSignal) => p.client.credentials(signal),
    [p.client],
  );
  const list = useOperatorResource(csrf, loader);
  useHeaderRefresh(p.refreshNonce, list.refresh);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [days, setDays] = useState(90);
  const [nameError, setNameError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<OperatorCredential | null>(null);
  const [revokeOutcome, setRevokeOutcome] = useState<Outcome | null>(null);
  const id = useId();
  const credentials = list.state.data?.data.credentials ?? [];
  const nameOf = (credentialId: string) =>
    `${credentials.find((c) => c.id === credentialId)?.name ?? "Unknown"} (${shortId(credentialId)})`;

  // A failed or unknown POST may still have recorded a change, so re-read the list.
  // Create and rotate cannot be resent (they have no request key), so their unconfirmed
  // outcome offers the re-read as its one action; revoke is by id and can simply be retried.
  const act = async (
    run: () => Promise<Outcome | null>,
    show: (outcome: Outcome | null) => void,
    what: {
      did: string;
      confirmed: string;
      resend: boolean;
      /** The closing sentence of a failure, when it has more to say than the reload. */
      after?: string;
      resource?: string;
    },
  ) => {
    setBusy(true);
    show(null);
    try {
      show(await run());
    } catch (error) {
      const code = error instanceof Error ? error.message : "request-failed";
      const details = { resource: what.resource, code };
      show(
        code === "command-outcome-unknown"
          ? {
              tone: "warning",
              message: `We couldn't confirm ${what.confirmed}. We're reloading the list below.`,
              details,
              check: !what.resend,
            }
          : {
              tone: "error",
              message: `Couldn't ${what.did}: ${failureCause(code)}. ${what.after ?? "We're reloading the list below."}`,
              details,
            },
      );
    } finally {
      list.refresh();
      setBusy(false);
    }
  };
  const reveal = (credential: OperatorCredential, token: string) =>
    setRevealed({ name: credential.name, token });
  const create = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!operatorCredentialNameSchema.safeParse(trimmed).success) {
      setNameError(
        "Name must be 1 to 64 characters without control characters.",
      );
      return;
    }
    setNameError(null);
    void act(
      async () => {
        const r = await p.client.issueCredential(
          { name: trimmed, scope, expiresInDays: days },
          csrf,
        );
        reveal(r.credential, r.token);
        setName("");
        // The one-time token dialog is the confirmation.
        return null;
      },
      setOutcome,
      {
        did: "create the credential",
        confirmed: "the credential was created",
        resend: false,
        after: "Your entries are still here; we're reloading the list below.",
      },
    );
  };
  return (
    <Panel
      title="CLI credentials"
      description="Bearer tokens for the operator CLI. Each is shown once, expires, and can be rotated or revoked."
    >
      <form className="settings-credentials-form" onSubmit={create} noValidate>
        <TextField
          id={`${id}-name`}
          label="Credential name"
          value={name}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? `${id}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && (
          <p className="error-text metadata" id={`${id}-error`} role="alert">
            {nameError}
          </p>
        )}
        <label className="field body" htmlFor={`${id}-scope`}>
          Scope
          <NativeSelect
            id={`${id}-scope`}
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="read">Read-only</option>
            <option value="read-write">Read-write</option>
          </NativeSelect>
        </label>
        <label className="field body" htmlFor={`${id}-lifetime`}>
          Lifetime
          <NativeSelect
            id={`${id}-lifetime`}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {lifetimes.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="settings-actions">
          <Button type="submit" disabled={busy}>
            Create credential
          </Button>
        </div>
      </form>
      {outcome && (
        <ActionOutcome
          tone={outcome.tone}
          message={outcome.message}
          action={
            outcome.check
              ? { label: "Check the list", onClick: list.refresh }
              : undefined
          }
          details={detailRows(outcome.details)}
        />
      )}
      {list.state.status === "error" && (
        <p className="error-text metadata" role="alert">
          Credentials are unavailable.{" "}
          <Button type="button" variant="secondary" onClick={list.refresh}>
            Retry
          </Button>
        </p>
      )}
      {list.state.data && credentials.length === 0 && (
        <p className="metadata muted">No CLI credentials.</p>
      )}
      <ul className="settings-credentials-list" aria-label="CLI credentials">
        {credentials.map((c) => (
          <li className="settings-row" key={c.id}>
            <div className="settings-row-heading">
              <h3 className="small-heading">{c.name}</h3>
              <StatusBadge tone={c.state === "active" ? "success" : "warning"}>
                {c.state === "active"
                  ? "Active"
                  : c.state === "expired"
                    ? "Expired"
                    : "Revoked"}
              </StatusBadge>
              {c.state === "active" && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Rotate ${c.name}`}
                    onClick={() =>
                      void act(
                        async () => {
                          const r = await p.client.rotateCredential(c.id, csrf);
                          reveal(r.credential, r.token);
                          return {
                            tone: "success",
                            message: `Rotated ${c.name}. The old credential stays active until you revoke it.`,
                            details: { resource: r.credential.id },
                          };
                        },
                        setOutcome,
                        {
                          did: `rotate ${c.name}`,
                          confirmed: `${c.name} was rotated`,
                          resend: false,
                          resource: c.id,
                        },
                      )
                    }
                  >
                    Rotate
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Revoke ${c.name}`}
                    onClick={() => {
                      setOutcome(null);
                      setRevokeOutcome(null);
                      setRevoking(c);
                    }}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </div>
            <dl className="settings-facts metadata">
              <div>
                <dt>ID</dt>
                <dd>{shortId(c.id)}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{scopeLabel(c.scope)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <When at={c.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>
                  <When at={c.expiresAt} />
                </dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>
                  {c.lastUsedAt === null ? "never" : <When at={c.lastUsedAt} />}
                </dd>
              </div>
              {c.replacesId && (
                <div>
                  <dt>Replaces</dt>
                  <dd>{nameOf(c.replacesId)}</dd>
                </div>
              )}
              {c.revokedAt !== null && (
                <div>
                  <dt>Revoked</dt>
                  <dd>
                    <When at={c.revokedAt} />
                  </dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {revealed && (
        <Reveal
          name={revealed.name}
          token={revealed.token}
          done={() => setRevealed(null)}
        />
      )}
      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
      >
        <DialogContent>
          <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
          <DialogDescription>
            Revocation is irreversible. Any CLI using this token stops working
            immediately, and it cannot be restored.
          </DialogDescription>
          {revokeOutcome && (
            <ActionOutcome
              tone={revokeOutcome.tone}
              message={revokeOutcome.message}
              details={detailRows(revokeOutcome.details)}
            />
          )}
          <div className="settings-actions">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = revoking;
                if (!target) return;
                void act(
                  async () => {
                    await p.client.revokeCredential(target.id, csrf);
                    setRevoking(null);
                    return {
                      tone: "success",
                      message: `Revoked ${target.name}.`,
                      details: { resource: target.id },
                    };
                  },
                  // Success closes the dialog, so its line belongs to the panel.
                  (o) =>
                    o?.tone === "success" ? setOutcome(o) : setRevokeOutcome(o),
                  {
                    did: `revoke ${target.name}`,
                    confirmed: `${target.name} was revoked`,
                    resend: true,
                    resource: target.id,
                  },
                );
              }}
            >
              Revoke credential
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
