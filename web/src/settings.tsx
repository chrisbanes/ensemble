import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  projectConfigurationSchema,
  profileConfigurationSchema,
  sourceObservationSchema,
  type Workspace,
  type Session,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import type {
  ConfigurationDraft,
  ConfigurationDrafts,
} from "./settings-state.js";
import { useOperatorResource } from "./resource.js";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
export interface SettingsProps {
  client: OperatorClient;
  session: Session;
  drafts: ConfigurationDrafts;
  workspace: Workspace | null;
  refresh: () => void;
}
export function useDraft(drafts: ConfigurationDrafts, key: string) {
  const [, render] = useReducer((v) => v + 1, 0);
  const d = drafts.get(key, render);
  return d;
}
export function DraftField({
  draft,
  field,
  errorField = field,
  label,
  multiline = false,
  children,
  type = "text",
}: {
  draft: ConfigurationDraft;
  field: string;
  errorField?: string;
  label: string;
  multiline?: boolean;
  children?: ReactNode;
  type?: string;
}) {
  const id = useId(),
    error = draft.errors[errorField],
    locked =
      draft.phase === "pending" ||
      draft.phase === "unknown" ||
      draft.phase === "recorded";
  const props = {
    id,
    "aria-label": label,
    disabled: locked,
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : undefined,
    className: "control",
    value: String(draft.values[field] ?? ""),
    onChange: (e: { target: { value: string } }) =>
      draft.set(field, e.target.value),
  };
  return (
    <label className="field body" htmlFor={id}>
      {label}
      {children ? (
        <select {...props}>{children}</select>
      ) : multiline ? (
        <textarea {...props} rows={4} />
      ) : (
        <input {...props} type={type} />
      )}{" "}
      {error && (
        <span id={`${id}-error`} className="error-text" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
export function DraftCheck({
  draft,
  field,
  label,
}: {
  draft: ConfigurationDraft;
  field: string;
  label: string;
}) {
  return (
    <label className="body check-field">
      <input
        type="checkbox"
        checked={Boolean(draft.values[field])}
        disabled={
          draft.phase === "pending" ||
          draft.phase === "unknown" ||
          draft.phase === "recorded"
        }
        onChange={(e) => draft.set(field, e.target.checked)}
      />
      {label}
    </label>
  );
}
export function DraftOutcome({
  draft,
  client,
  session,
  label,
}: {
  draft: ConfigurationDraft;
  client: OperatorClient;
  session: Session;
  label: string;
}) {
  return (
    <>
      <div className="settings-actions">
        {draft.phase === "unknown" ? (
          <Button
            type="button"
            onClick={() => void draft.reconcile(client, session.csrfToken)}
          >
            Reconcile exact submission
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={draft.phase === "pending" || draft.phase === "recorded"}
          >
            {draft.phase === "pending" ? "Saving…" : label}
          </Button>
        )}
      </div>
      {draft.notice && (
        <p className="body" role="status">
          {draft.notice}
        </p>
      )}
      {draft.receipt?.kind === "configuration" && (
        <p className="metadata">
          {draft.receipt.result.commandType === "capacity.configure" ? (
            <>
              Recorded capacity limits: global{" "}
              {draft.receipt.result.globalLimit}; default project{" "}
              {draft.receipt.result.defaultProjectLimit}; project overrides{" "}
              {Object.entries(draft.receipt.result.projectOverrides)
                .map(([id, limit]) => `${id}: ${limit}`)
                .join(", ") || "none"}
            </>
          ) : (
            <>
              Recorded {draft.receipt.result.commandType}:{" "}
              {draft.receipt.result.resourceId}; version{" "}
              {"version" in draft.receipt.result
                ? draft.receipt.result.version
                : draft.receipt.result.configVersion}
            </>
          )}
          .
        </p>
      )}
    </>
  );
}
export async function submitDraft(
  e: FormEvent,
  d: ConfigurationDraft,
  client: OperatorClient,
  session: Session,
  command: unknown,
  refresh: () => void,
) {
  const form = e.currentTarget;
  e.preventDefault();
  await d.submit(client, command, session.csrfToken);
  if (d.phase === "recorded") refresh();
  else if (d.phase === "rejected")
    requestAnimationFrame(() =>
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
}
const key = () => crypto.randomUUID();
export function SettingsWorkspace(p: SettingsProps) {
  return (
    <section className="settings-stack">
      <p className="introduction muted">
        Configure paused projects, reusable profiles and installation capacity.
        Each change is saved separately.
      </p>
      <div className="settings-actions">
        <a className="control button primary" href="/app/settings/projects/new">
          Create project
        </a>
        <a
          className="control button secondary"
          href="/app/settings/profiles/new"
        >
          Create profile
        </a>
        <a className="control button secondary" href="/app/settings/runtime">
          Runtime and recovery
        </a>
      </div>
      <h2 className="section-heading">Projects</h2>
      {p.workspace?.data.projects.map((r) => (
        <div className="settings-card" key={r.id}>
          <a href={`/app/projects/${r.id}/settings`}>
            {r.name ?? "Name unavailable"}
          </a>{" "}
          <StatusBadge tone={r.paused ? "warning" : "neutral"}>
            {r.paused ? "Paused" : "Enabled"}
          </StatusBadge>
          <p className="metadata">Configuration version {r.version}</p>
        </div>
      ))}
      <h2 className="section-heading">Profiles</h2>
      {p.workspace?.data.profiles.map((r) => (
        <div className="settings-card" key={r.id}>
          <a href={`/app/profiles/${r.id}/settings`}>
            {r.name ?? "Name unavailable"}
          </a>{" "}
          <StatusBadge>{r.revoked ? "Revoked" : "Available"}</StatusBadge>
          <p className="metadata">Revision {r.version}</p>
        </div>
      ))}
    </section>
  );
}
export function ProjectSetup(p: SettingsProps) {
  const d = useDraft(p.drafts, "project.create");
  useEffect(
    () =>
      d.initialize({
        name: "",
        leadProfileId: "",
        projectId: key(),
        key: key(),
      }),
    [d],
  );
  const recorded =
    d.receipt?.kind === "configuration" ? d.receipt.result : null;
  return (
    <section className="settings-stack">
      <a href="/app/settings">Settings home</a>
      <h2 className="section-heading">Create project</h2>
      <p className="body muted">
        First choose a lead, or leave it unconfigured. A new project starts
        paused. Creating it starts no execution. Instructions and optional
        repository access are separately saved steps.
      </p>
      <a href="/app/settings/profiles/new">Create a lead profile</a>
      <form
        onSubmit={(e) =>
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "project.create",
              key: d.values.key,
              projectId: d.values.projectId,
              name: d.values.name,
              leadProfileId: d.values.leadProfileId || null,
            },
            p.refresh,
          )
        }
      >
        <DraftField draft={d} field="name" label="Project name" />
        <DraftField draft={d} field="leadProfileId" label="Lead profile">
          <option value="">Unconfigured</option>
          {p.workspace?.data.profiles
            .filter((r) => !r.revoked)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name ?? "Name unavailable"}
              </option>
            ))}
        </DraftField>
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Create paused project"
        />
      </form>
      {recorded && (
        <a href={`/app/projects/${recorded.resourceId}/settings`}>
          Set instructions and optional source access
        </a>
      )}
      {recorded && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            d.startOperation({
              name: "",
              leadProfileId: "",
              projectId: key(),
              key: key(),
            })
          }
        >
          Create another project
        </Button>
      )}
    </section>
  );
}
export function ProfileConfiguration(
  p: SettingsProps & { profileId?: string },
) {
  const { profileId } = p,
    d = useDraft(
      p.drafts,
      profileId ? `profile.configure:${profileId}` : "profile.create",
    );
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        `/api/operator/profiles/${profileId}/configuration`,
        profileConfigurationSchema,
        signal,
      ),
    [p.client, profileId],
  );
  const resource = useOperatorResource(
      profileId ? `${p.session.csrfToken}:${profileId}` : null,
      loader,
    ),
    data = resource.state.data?.data;
  useEffect(() => {
    if (!profileId)
      d.initialize({
        name: "",
        instructions: "",
        capabilities: "",
        profileId: key(),
        key: key(),
      });
    else if (data)
      d.initialize({
        name: data.profile.name ?? "",
        replaceInstructions: false,
        replaceCapabilities: false,
        instructions: "",
        capabilities: "",
        revoked: data.profile.revoked,
        expectedVersion: String(data.profile.version),
        key: key(),
      });
  }, [d, profileId, data]);
  const command = () => ({
    type: profileId ? "profile.configure" : "profile.create",
    key: d.values.key,
    profileId: profileId ?? d.values.profileId,
    ...(profileId && data?.profile.name === null && d.values.name === ""
      ? {}
      : { name: d.values.name }),
    ...(profileId
      ? {
          expectedVersion: Number(d.values.expectedVersion),
          revoked: Boolean(d.values.revoked),
        }
      : {}),
    ...(!profileId || d.values.replaceInstructions
      ? { instructions: d.values.instructions }
      : {}),
    ...(!profileId || d.values.replaceCapabilities
      ? { capabilities: d.values.capabilities }
      : {}),
  });
  return (
    <section className="settings-stack">
      <a href="/app/settings">Settings home</a>
      <h2 className="section-heading">
        {profileId ? "Profile configuration" : "Create profile"}
      </h2>
      {profileId && (
        <>
          <ResourceStatus
            label="Profile configuration"
            state={resource.state}
            retry={resource.refresh}
          />
          <Button type="button" variant="secondary" onClick={resource.refresh}>
            Reload profile configuration
          </Button>
          {data && (
            <p className="body">
              Current revision {data.profile.version}.{" "}
              {data.profile.revoked
                ? "Revoked: subsequent actions are denied."
                : "Available for permitted selection."}{" "}
              Existing assignments keep their captured profile revision until
              explicit Apply.
            </p>
          )}
          <a href={`/profile/${profileId}`}>
            Open exact private profile editor
          </a>
          <p className="body muted">
            Current instructions are private. Capabilities:{" "}
            {data?.capabilities ?? "Unavailable"}. Replacement fields start
            empty; omissions preserve saved values.
          </p>
        </>
      )}
      {(!profileId || data) && (
        <form
          onSubmit={(e) =>
            void submitDraft(e, d, p.client, p.session, command(), () => {
              p.refresh();
              resource.refresh();
            })
          }
        >
          <DraftField draft={d} field="name" label="Profile name" />
          {profileId && (
            <DraftCheck draft={d} field="revoked" label="Revoke profile" />
          )}
          {profileId && (
            <DraftCheck
              draft={d}
              field="replaceInstructions"
              label="Replace instructions"
            />
          )}
          {(!profileId || d.values.replaceInstructions) && (
            <DraftField
              draft={d}
              field="instructions"
              label="New instructions"
              multiline
            />
          )}
          {profileId && (
            <DraftCheck
              draft={d}
              field="replaceCapabilities"
              label="Replace capabilities"
            />
          )}
          {(!profileId || d.values.replaceCapabilities) && (
            <DraftField
              draft={d}
              field="capabilities"
              label="Capabilities"
              multiline
            />
          )}
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label={profileId ? "Save profile" : "Create profile"}
          />
          {!profileId && d.phase === "recorded" && (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                d.startOperation({
                  name: "",
                  instructions: "",
                  capabilities: "",
                  profileId: key(),
                  key: key(),
                })
              }
            >
              Create another profile
            </Button>
          )}
          {profileId &&
            data &&
            (d.phase === "recorded" || d.phase === "conflict") && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => d.adoptVersion(data.profile.version)}
              >
                Review latest profile revision
              </Button>
            )}
        </form>
      )}
    </section>
  );
}
export function ProjectConfiguration(p: SettingsProps & { projectId: string }) {
  const { projectId } = p,
    d = useDraft(p.drafts, `project.configure:${projectId}`),
    loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          `/api/operator/projects/${projectId}/configuration`,
          projectConfigurationSchema,
          signal,
        ),
      [p.client, projectId],
    ),
    resource = useOperatorResource(
      `${p.session.csrfToken}:${projectId}`,
      loader,
    ),
    data = resource.state.data?.data;
  useEffect(() => {
    if (data)
      d.initialize({
        name: data.project.name ?? "",
        leadProfileId: data.project.leadProfileId ?? "",
        paused: data.project.paused,
        replaceInstructions: false,
        instructions: "",
        expectedVersion: String(data.project.version),
        key: key(),
      });
  }, [data, d]);
  const command = () => ({
    type: "project.configure",
    key: d.values.key,
    projectId,
    expectedVersion: Number(d.values.expectedVersion),
    ...(data?.project.name === null && d.values.name === ""
      ? {}
      : { name: d.values.name }),
    paused: Boolean(d.values.paused),
    ...(d.dirty && d.values.leadProfileId !== data?.project.leadProfileId
      ? { leadProfileId: d.values.leadProfileId || null }
      : {}),
    ...(d.values.replaceInstructions
      ? { instructions: d.values.instructions }
      : {}),
  });
  return (
    <section className="settings-stack">
      <a href="/app/settings">Settings home</a>
      <ResourceStatus
        label="Project configuration"
        state={resource.state}
        retry={resource.refresh}
      />
      <Button type="button" variant="secondary" onClick={resource.refresh}>
        Reload project configuration
      </Button>
      {data && (
        <>
          <h2 className="section-heading">Project configuration</h2>
          <p className="body">
            Current configuration version {data.project.version}; instruction
            revision {data.instructionsRevision}.{" "}
            {data.project.paused
              ? "Paused: new admission is held."
              : "Enabled: existing admission rules still apply."}
          </p>
          <p className="body muted">
            Assignments retain captured revisions until explicit Apply for the
            next turn. Current private instructions are never loaded into this
            form. An empty explicit replacement clears them.
          </p>
          <a href={`/project/${projectId}`}>
            Open exact private project editor
          </a>
          <p className="body muted">
            Delivery completion mode, scoped authority grants, required checks
            and credentials remain in the authenticated{" "}
            <a href={`/project/${projectId}`}>
              Open delivery policy and authority editor
            </a>
            .
          </p>
          <form
            onSubmit={(e) =>
              void submitDraft(e, d, p.client, p.session, command(), () => {
                p.refresh();
                resource.refresh();
              })
            }
          >
            <DraftField draft={d} field="name" label="Project name" />
            <DraftField draft={d} field="leadProfileId" label="Lead profile">
              <option value="">Unconfigured</option>
              {data.profiles
                .filter(
                  (r) => !r.revoked || r.id === data.project.leadProfileId,
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name ?? "Name unavailable"}
                    {r.revoked ? " (revoked)" : ""}
                  </option>
                ))}
            </DraftField>
            <DraftCheck draft={d} field="paused" label="Pause project" />
            <DraftCheck
              draft={d}
              field="replaceInstructions"
              label="Replace instructions"
            />
            {d.values.replaceInstructions && (
              <DraftField
                draft={d}
                field="instructions"
                label="New instructions"
                multiline
              />
            )}
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save project"
            />
            {(d.phase === "recorded" || d.phase === "conflict") && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => d.adoptVersion(data.project.version)}
              >
                Review latest project revision
              </Button>
            )}
          </form>
          <a href={`/app/projects/${projectId}`}>Project tasks</a>
          <RoutingConfiguration
            {...p}
            data={data}
            refreshConfiguration={resource.refresh}
          />
          <SourceConfiguration
            {...p}
            data={data}
            refreshConfiguration={resource.refresh}
          />
        </>
      )}
    </section>
  );
}

function reference(d: ConfigurationDraft) {
  const mode = d.values.referenceMode;
  return mode === "clear"
    ? { credentialRef: null }
    : mode === "set"
      ? { credentialRef: d.values.credentialRef }
      : {};
}
function ReferenceInput({ draft }: { draft: ConfigurationDraft }) {
  return (
    <>
      <DraftField
        draft={draft}
        field="referenceMode"
        label="Credential reference change"
      >
        <option value="preserve">Preserve current reference</option>
        <option value="set">Set new environment reference</option>
        <option value="clear">Clear reference</option>
      </DraftField>
      {draft.values.referenceMode === "set" && (
        <DraftField
          draft={draft}
          field="credentialRef"
          label="New environment reference"
        />
      )}
      <p className="metadata muted">
        Only an env:NAME reference is accepted. Its value stays server-side.
      </p>
    </>
  );
}
type ProjectConfigurationData = ReturnType<
  typeof projectConfigurationSchema.parse
>["data"];
export function RoutingConfiguration(
  p: SettingsProps & {
    projectId: string;
    data: ProjectConfigurationData;
    refreshConfiguration: () => void;
  },
) {
  const d = useDraft(p.drafts, `routing.configure:${p.projectId}`);
  useEffect(
    () =>
      d.initialize({
        key: key(),
        expectedVersion: String(p.data.routing.version),
        enabled: p.data.routing.enabled,
        guidance: "",
        candidateProfileIds: [],
        referenceMode: "preserve",
        credentialRef: "",
      }),
    [d, p.data.routing.version, p.data.routing.enabled],
  );
  const candidates = Array.isArray(d.values.candidateProfileIds)
    ? d.values.candidateProfileIds
    : [];
  return (
    <section className="settings-card">
      <h2 className="section-heading">Routing</h2>
      <p className="body">
        {p.data.routing.enabled ? "Enabled" : "Disabled"}. Availability:{" "}
        {p.data.routing.availability}. Reference{" "}
        {p.data.routing.credentialConfigured ? "configured" : "unconfigured"}.
        Version {p.data.routing.version}.
      </p>
      <p className="body">
        Current candidates:{" "}
        {p.data.routing.candidateProfileIds
          .map(
            (id) =>
              p.data.profiles.find((r) => r.id === id)?.name ??
              "Name unavailable",
          )
          .join(", ") || "None"}
        .
      </p>
      <p className="body muted">
        This form replaces guidance and the complete candidate selection. For a
        partial edit preserving exact private guidance, use the{" "}
        <a href={`/project/${p.projectId}`}>exact routing editor</a>.
      </p>
      <form
        onSubmit={(e) =>
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "routing.configure",
              key: d.values.key,
              projectId: p.projectId,
              expectedVersion: Number(d.values.expectedVersion),
              enabled: Boolean(d.values.enabled),
              guidance: d.values.guidance,
              candidateProfileIds: candidates,
              ...reference(d),
            },
            p.refreshConfiguration,
          )
        }
      >
        <DraftCheck draft={d} field="enabled" label="Enable routing" />
        <DraftField
          draft={d}
          field="guidance"
          label="Complete replacement guidance"
          multiline
        />
        <fieldset
          disabled={
            d.phase === "pending" ||
            d.phase === "unknown" ||
            d.phase === "recorded"
          }
        >
          <legend className="body">Complete replacement candidates</legend>
          {p.data.profiles.map((r) => (
            <label key={r.id} className="check-field body">
              <input
                type="checkbox"
                checked={candidates.includes(r.id)}
                disabled={r.revoked}
                onChange={(e) =>
                  d.set(
                    "candidateProfileIds",
                    e.target.checked
                      ? [...candidates, r.id]
                      : candidates.filter((id) => id !== r.id),
                  )
                }
              />
              {r.name ?? "Name unavailable"}
              {r.revoked ? " (revoked)" : ""}
            </label>
          ))}
        </fieldset>
        <ReferenceInput draft={d} />
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Replace routing"
        />
        {(d.phase === "recorded" || d.phase === "conflict") && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => d.adoptVersion(p.data.routing.version)}
          >
            Review latest routing revision
          </Button>
        )}
      </form>
    </section>
  );
}
type RowInput = Record<string, string>;
function submittedRows(d: ConfigurationDraft, field: string) {
  return rows(d, field).map(({ rowKey: _rowKey, ...row }) => row);
}
function rows(d: ConfigurationDraft, field: string): RowInput[] {
  try {
    return JSON.parse(String(d.values[field] ?? "[]"));
  } catch {
    return [];
  }
}
export function SourceConfiguration(
  p: SettingsProps & {
    projectId: string;
    data: ProjectConfigurationData;
    refreshConfiguration: () => void;
  },
) {
  const d = useDraft(p.drafts, `github.configure:${p.projectId}`),
    preview = useDraft(p.drafts, `github.preview:${p.projectId}`);
  useEffect(
    () =>
      d.initialize({
        key: key(),
        expectedVersion: String(p.data.source.version),
        referenceMode: "preserve",
        credentialRef: "",
        selections: "[]",
        conditions: JSON.stringify([
          { kind: "label", name: "ready", rowKey: key() },
        ]),
        mode: "all",
        repositories: "[]",
        replaceConfirmed: false,
      }),
    [d, p.data.source.version],
  );
  useEffect(
    () =>
      preview.initialize({
        key: key(),
        expectedVersion: String(p.data.source.version),
        selectionId:
          p.data.source.selections.find((s) => s.id !== null)?.id ?? "",
      }),
    [preview, p.data.source.version, p.data.source.selections],
  );
  const selections = rows(d, "selections"),
    conditions = rows(d, "conditions"),
    repositories = rows(d, "repositories"),
    locked =
      d.phase === "pending" || d.phase === "unknown" || d.phase === "recorded";
  const update = (
    field: string,
    index: number,
    name: string,
    value: string,
  ) => {
    const items = rows(d, field);
    items[index] = { ...items[index], [name]: value };
    d.set(field, JSON.stringify(items));
  };
  const remove = (field: string, index: number) =>
    d.set(field, JSON.stringify(rows(d, field).filter((_, i) => i !== index)));
  const add = (field: string, row: RowInput) =>
    d.set(
      field,
      JSON.stringify([...rows(d, field), { ...row, rowKey: key() }]),
    );
  const rowError = (field: string, index: number, name: string) => {
    const path = field === "conditions" ? "readiness.conditions" : field;
    return (
      d.errors[path] ||
      d.errors[`${path}.${index}.${name}`] ||
      d.errors[`${path}.${name}`]
    );
  };
  const input = (field: string, index: number, name: string, label: string) => (
    <label className="field body" htmlFor={`source-${field}-${index}-${name}`}>
      {label}
      <input
        className="control"
        id={`source-${field}-${index}-${name}`}
        aria-invalid={Boolean(rowError(field, index, name))}
        aria-describedby={
          rowError(field, index, name) ? `source-${field}-error` : undefined
        }
        value={rows(d, field)[index]?.[name] ?? ""}
        onChange={(e) => update(field, index, name, e.target.value)}
      />
    </label>
  );
  return (
    <section className="settings-card">
      <h2 className="section-heading">
        GitHub discovery and repository access
      </h2>
      <p className="body">
        Configuration version {p.data.source.version}. Credential reference{" "}
        {p.data.source.credentialConfigured ? "configured" : "unconfigured"}.
        Discovery and readiness never grant repository access.
      </p>
      <ul className="body">
        {p.data.source.selections.map((s, i) => (
          <li key={s.id ?? i}>
            {s.id ?? "ID unavailable"} — {s.kind};{" "}
            {s.descriptor ?? "Private descriptor unavailable"};{" "}
            {s.active ? "Preview activated" : "Inactive"}
          </li>
        ))}
      </ul>
      <p className="body" data-current-readiness>
        Readiness:{" "}
        {p.data.source.readiness
          ? `${p.data.source.readiness.mode === "all" ? "All" : "Any"} conditions: ${p.data.source.readiness.conditions.map((c) => (c.kind === "label" ? `label ${c.name}` : `Project ${c.projectNodeId}, field ${c.fieldNodeId}, option ${c.optionNodeId}`)).join("; ")}`
          : "Unavailable"}
      </p>
      <ul className="body">
        {p.data.source.repositories.map((r, i) => (
          <li key={r.repositoryId ?? i}>
            {r.repositoryId ?? "Repository unavailable"}; ref{" "}
            {r.ref ?? "unavailable"}; current path private
          </li>
        ))}
      </ul>
      <p className="body muted">
        Complete replacement requires all selections, readiness conditions and
        repositories. Existing search queries, filters and repository paths are
        not populated. Use the{" "}
        <a href={`/project/${p.projectId}`}>exact source editor</a> for private
        or partial existing-value edits.
      </p>
      <form
        onSubmit={(e) => {
          if (!d.values.replaceConfirmed) {
            e.preventDefault();
            d.errors = { repositories: "Confirm complete replacement." };
            d.notice = "Confirm full replacement before saving.";
            d.set("replaceConfirmed", false);
            return;
          }
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "github.configure",
              key: d.values.key,
              projectId: p.projectId,
              expectedVersion: Number(d.values.expectedVersion),
              selections: submittedRows(d, "selections"),
              readiness: {
                mode: d.values.mode,
                conditions: submittedRows(d, "conditions"),
              },
              repositories: submittedRows(d, "repositories"),
              ...reference(d),
            },
            p.refreshConfiguration,
          );
        }}
      >
        <fieldset disabled={locked}>
          <legend className="section-heading">
            Complete replacement selections
          </legend>
          {Object.keys(d.errors).some((k) => k.startsWith("selections")) && (
            <p
              id="source-selections-error"
              className="body error-text"
              role="alert"
            >
              Check the complete selection fields.
            </p>
          )}
          {selections.map((r, i) => (
            <div className="settings-card" key={r.rowKey}>
              <label className="field body" htmlFor={`selection-kind-${i}`}>
                Selection kind
                <select
                  className="control"
                  id={`selection-kind-${i}`}
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value;
                    const next =
                      kind === "repository"
                        ? {
                            kind,
                            id: r.id ?? "",
                            repositoryId: "",
                            owner: "",
                            name: "",
                          }
                        : kind === "project"
                          ? {
                              kind,
                              id: r.id ?? "",
                              projectNodeId: "",
                              filter: "",
                            }
                          : { kind, id: r.id ?? "", query: "" };
                    const items = [...selections];
                    items[i] = { ...next, rowKey: r.rowKey ?? key() };
                    d.set("selections", JSON.stringify(items));
                  }}
                >
                  <option value="repository">Repository</option>
                  <option value="search">Search</option>
                  <option value="project">GitHub Project</option>
                </select>
              </label>
              {input("selections", i, "id", "Selection ID")}
              {r.kind === "repository" ? (
                <>
                  {input("selections", i, "repositoryId", "Repository ID")}
                  {input("selections", i, "owner", "Repository owner")}
                  {input("selections", i, "name", "Repository name")}
                </>
              ) : r.kind === "project" ? (
                <>
                  {input(
                    "selections",
                    i,
                    "projectNodeId",
                    "GitHub Project node ID",
                  )}
                  {input("selections", i, "filter", "Complete Project filter")}
                </>
              ) : (
                input("selections", i, "query", "Complete search query")
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => remove("selections", i)}
              >
                Remove selection {i + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              add("selections", {
                id: "",
                kind: "repository",
                repositoryId: "",
                owner: "",
                name: "",
              })
            }
          >
            Add selection
          </Button>
        </fieldset>
        <fieldset
          disabled={locked}
          tabIndex={-1}
          aria-invalid={Boolean(d.errors["readiness.conditions"])}
          aria-describedby={
            d.errors["readiness.conditions"]
              ? "source-conditions-error"
              : undefined
          }
        >
          <legend className="section-heading">Readiness replacement</legend>
          {Object.keys(d.errors).some((k) => k.startsWith("readiness")) && (
            <p
              id="source-conditions-error"
              className="body error-text"
              role="alert"
            >
              Check readiness mode and complete conditions.
            </p>
          )}
          <DraftField
            draft={d}
            field="mode"
            errorField="readiness.mode"
            label="Readiness matching"
          >
            <option value="all">All conditions</option>
            <option value="any">Any condition</option>
          </DraftField>
          {conditions.map((r, i) => (
            <div className="settings-card" key={r.rowKey}>
              <label className="field body" htmlFor={`condition-kind-${i}`}>
                Condition kind
                <select
                  className="control"
                  id={`condition-kind-${i}`}
                  aria-invalid={Boolean(rowError("conditions", i, "kind"))}
                  aria-describedby={
                    rowError("conditions", i, "kind")
                      ? "source-conditions-error"
                      : undefined
                  }
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value,
                      items = [...conditions];
                    items[i] = {
                      ...(kind === "label"
                        ? { kind, name: "" }
                        : {
                            kind,
                            projectNodeId: "",
                            fieldNodeId: "",
                            optionNodeId: "",
                          }),
                      rowKey: r.rowKey ?? key(),
                    };
                    d.set("conditions", JSON.stringify(items));
                  }}
                >
                  <option value="label">Label</option>
                  <option value="project-field">Project field</option>
                </select>
              </label>
              {r.kind === "label" ? (
                input("conditions", i, "name", "Ready label")
              ) : (
                <>
                  {input(
                    "conditions",
                    i,
                    "projectNodeId",
                    "Readiness Project node ID",
                  )}
                  {input(
                    "conditions",
                    i,
                    "fieldNodeId",
                    "Readiness field node ID",
                  )}
                  {input(
                    "conditions",
                    i,
                    "optionNodeId",
                    "Readiness option node ID",
                  )}
                </>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => remove("conditions", i)}
              >
                Remove condition {i + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() => add("conditions", { kind: "label", name: "" })}
          >
            Add readiness condition
          </Button>
        </fieldset>
        <fieldset
          disabled={locked}
          aria-describedby={
            d.errors.repositories ? "source-repositories-error" : undefined
          }
        >
          <legend className="section-heading">
            Repository access replacement
          </legend>
          {repositories.map((r, i) => (
            <div className="settings-card" key={r.rowKey}>
              {input("repositories", i, "repositoryId", "Linked repository ID")}
              {input("repositories", i, "path", "New local repository path")}
              {input("repositories", i, "ref", "Linked repository ref")}
              <Button
                type="button"
                variant="secondary"
                onClick={() => remove("repositories", i)}
              >
                Remove repository {i + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              add("repositories", { repositoryId: "", path: "", ref: "main" })
            }
          >
            Add linked repository
          </Button>
          {Object.keys(d.errors).some((k) => k.startsWith("repositories")) && (
            <p
              id="source-repositories-error"
              className="body error-text"
              role="alert"
            >
              Check linked repository IDs, paths and refs.
            </p>
          )}
        </fieldset>
        <ReferenceInput draft={d} />
        <DraftCheck
          draft={d}
          field="replaceConfirmed"
          label="Replace all selections, readiness and repositories, including explicit empty lists"
        />
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Replace source configuration"
        />
        {(d.phase === "recorded" || d.phase === "conflict") && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => d.adoptVersion(p.data.source.version)}
          >
            Review latest source revision
          </Button>
        )}
      </form>
      <h3 className="section-heading">Preview and activation</h3>
      <p className="body muted">
        A complete version-matched preview activates the selected discovery
        source. Activation is separate from task import or successful sync.
      </p>
      <form
        onSubmit={(e) =>
          void submitDraft(
            e,
            preview,
            p.client,
            p.session,
            {
              type: "github.preview",
              key: preview.values.key,
              projectId: p.projectId,
              selectionId: preview.values.selectionId,
              expectedVersion: Number(preview.values.expectedVersion),
            },
            p.refreshConfiguration,
          )
        }
      >
        <DraftField
          draft={preview}
          field="selectionId"
          label="Selection to preview"
        >
          <option value="">Choose selection</option>
          {p.data.source.selections
            .filter((s) => s.id !== null)
            .map((s) => (
              <option value={s.id ?? ""} key={s.id}>
                {s.id} ({s.kind})
              </option>
            ))}
        </DraftField>
        <DraftOutcome
          draft={preview}
          client={p.client}
          session={p.session}
          label="Preview and activate selection"
        />
        {(preview.phase === "recorded" || preview.phase === "conflict") && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => preview.adoptVersion(p.data.source.version)}
          >
            Review latest preview revision
          </Button>
        )}
      </form>
      <SourceObservations {...p} />
      {p.data.placements.map((c) => (
        <PlacementConfiguration key={c.taskId} {...p} placement={c} />
      ))}
      {p.drafts
        .unsettledPlacements(p.projectId)
        .filter(
          (c) => !p.data.placements.some((row) => row.taskId === c.taskId),
        )
        .map((command) => (
          <UnsettledPlacement key={command.taskId} {...p} command={command} />
        ))}
      {p.drafts.placementReceipts(p.projectId).map((receipt) => (
        <p key={receipt.key} className="body" role="status">
          Recorded placement outcome: task {receipt.result.resourceId}; project{" "}
          {receipt.result.commandType === "github.place"
            ? receipt.result.projectId
            : "Unavailable"}
          ; version{" "}
          {"version" in receipt.result ? receipt.result.version : "Unavailable"}
          . Latest observations may differ from this original receipt.
        </p>
      ))}
    </section>
  );
}
function SourceObservations(p: SettingsProps & { projectId: string }) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/source-observations",
          sourceObservationSchema,
          signal,
        ),
      [p.client],
    ),
    resource = useOperatorResource(p.session.csrfToken, loader),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <section>
      <h3 className="section-heading">Source observations</h3>
      <ResourceStatus
        label="Source observations"
        state={resource.state}
        retry={resource.refresh}
      />
      {resource.state.data?.data.projects
        .find((r) => r.projectId === p.projectId)
        ?.selections.map((s, i) => (
          <p className="body" key={s.selectionId ?? i}>
            {s.selectionId ?? "Selection unavailable"}: {s.state}. Newest
            attempt: {s.lastAttemptAt ?? "unavailable"}. Successful sync:{" "}
            {s.lastSuccessfulAt ?? "unavailable"}.
          </p>
        ))}
      <p className="metadata muted">
        Refresh requests observations for all enabled sources in this
        installation. An attempt is separate from successful provider sync; it
        creates no domain receipt.
      </p>
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setNotice("Observation refresh requested.");
          try {
            await p.client.refreshSources(p.session.csrfToken);
            setNotice(
              "Observation request completed. Review complete, partial and unavailable states below.",
            );
            resource.refresh();
          } catch {
            setNotice(
              "Observation refresh unconfirmed. Read observations again or deliberately request another refresh.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        Request installation-wide source observations
      </Button>
      {notice && (
        <p className="body" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
function UnsettledPlacement(
  p: SettingsProps & {
    command: Extract<OperatorCommand, { type: "github.place" }>;
  },
) {
  const d = useDraft(p.drafts, `github.place:${p.command.taskId}`);
  return (
    <section>
      <h3 className="section-heading">Placement submission outcome</h3>
      <p className="body">
        Original project {p.command.projectId}; task {p.command.taskId};
        submitted task version {p.command.expectedVersion}; chosen project{" "}
        {p.command.chosenProjectId}. Current conflict observations cannot
        confirm this submission.
      </p>
      <DraftOutcome
        draft={d}
        client={p.client}
        session={p.session}
        label="Placement pending"
      />
    </section>
  );
}
function PlacementConfiguration(
  p: SettingsProps & {
    placement: ProjectConfigurationData["placements"][number];
    refreshConfiguration: () => void;
  },
) {
  const c = p.placement,
    d = useDraft(p.drafts, `github.place:${c.taskId}`);
  useEffect(
    () =>
      d.initialize({
        key: key(),
        expectedVersion: String(c.version),
        chosenProjectId: "",
        placementOriginProjectId: p.projectId,
      }),
    [d, c.version, p.projectId],
  );
  return (
    <section>
      <h3 className="section-heading">Conflicting source placement</h3>
      <p className="body">
        {c.title ?? "Task title unavailable"}; task version {c.version}.
      </p>
      <a href={`/task/${c.taskId}`}>Task source review</a>
      <form
        onSubmit={(e) => {
          d.set("placementOriginProjectId", p.projectId);
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "github.place",
              key: d.values.key,
              projectId: c.projectId,
              taskId: c.taskId,
              chosenProjectId: d.values.chosenProjectId,
              expectedVersion: Number(d.values.expectedVersion),
            },
            p.refreshConfiguration,
          );
        }}
      >
        <DraftField draft={d} field="chosenProjectId" label="Placement project">
          <option value="">Choose actual membership</option>
          {c.choices.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name ?? "Name unavailable"}
            </option>
          ))}
        </DraftField>
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Record placement"
        />
        {d.phase === "conflict" && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => d.adoptVersion(c.version)}
          >
            Review latest placement revision
          </Button>
        )}
      </form>
    </section>
  );
}
