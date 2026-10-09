---
status: accepted
---

# Discover repositories and pick checkouts during project setup

Chris asked for these decisions on 9 October 2026 while reviewing the settings and
setup designs (`design/design.pen`, frames 114–117 and 131). They amend the
guided project setup in [SPEC.md](../SPEC.md#task-creation-and-project-setup).
This records target contracts, not implemented behaviour. The current build asks
for typed repository IDs, refs and local paths.

## Discovery

Setup lists repositories, refs and GitHub Projects from GitHub instead of asking
for typed identifiers:

- **Repository:** repositories visible to the discovery credential.
- **Ref:** branches of the chosen repository, with the default branch preselected.
- **GitHub Project:** Projects linked to the chosen repositories, then other
  Projects owned by the same owner.

Discovery uses an installation-level GitHub credential reference (`env:NAME`),
held server-side like other credentials and used only for reads. A project can
still set its own source credential later. Discovered lists are suggestions for
the form; they are not stored as access, sources or task data.

When the credential is missing or a read fails, setup shows the reason and accepts
typed owner/name and ref values. Local checkout verification still applies.

## Folder picker

A web page cannot learn a folder's absolute path, and the operator may use the UI
from another device. The Ensemble service therefore serves the picker. An
authenticated operator route lists subfolder names and their Git status under the
operator's home folder. It never returns file contents. A typed path stays
available. Agents and model tools cannot use this route. Disclose it as listing
folders on the host.

## Verification

When a folder is chosen, and again on create, the service checks that it is a Git
checkout. Its origin must match the chosen repository, including the provider
instance, and the ref must be available. A mismatch is a field error that keeps
every other value.

## Linking a GitHub Project

Linking a discovered GitHub Project adds an inactive discovery source. Preview,
readiness and activation stay in project configuration, unchanged.

## Unchanged

Discovery, source selection and a linked GitHub Project grant no repository access.
Access is exactly the repositories the operator adds. Readiness and admission rules
are unchanged.

## Alternatives rejected

- **Native macOS folder dialog launched by the service.** It opens on the host's
  screen, so it fails for remote or phone use and blocks on an unattended host.
- **Browser folder APIs.** They return handles or relative names, not absolute
  paths, and support differs by browser.
- **Storing discovered lists.** They go stale, and stored copies could be mistaken
  for access.

## Open

Setup still needs either one create command or chained keyed commands that report
which steps were recorded after a partial failure. The design shows one
"Create paused project" action.
