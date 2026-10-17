# Approve an exact action

**Status:** planned. The Inbox and task decision card reach the exact-material
approval today; the budget below is not yet asserted by a journey test.

## Goal

The operator reads the exact action, target and material, decides once, and sees
the decision recorded against that material.

The Inbox never approves or denies. The decision is made on the retained
exact-material destination, because the [specification](../SPEC.md#github-and-completion)
binds approval to "the action, target, requester and reviewed material; changed
material invalidates approval".

## Entry points

- Home "Needs you" card.
- Inbox queue row.
- Task detail decision card.
- Browser notification (opt-in, Settings → Notifications): opens the exact Inbox
  selection after sign-in. It is outside the budget below, and it never approves.
- Operator CLI `approval decide`.

## Steps

1. The row or card names the exact action ("Create a pull request") with the task
   beneath it and Review material & decide.
2. The request pane shows action, target, requester, material version and any
   independent hold the decision does not clear, then one Review material & decide.
3. The exact-material view shows the material in full with Approve, Deny and Leave
   pending. Approve confirms once.
4. The recorded decision shows on the request, the task and the Inbox row, with any
   remaining hold stated beside it.

## Budget

| Entry point | Interactions to a recorded decision | First screen must show |
| --- | --- | --- |
| Home card | 3 (Review material & decide, Approve, confirm) | the exact action and the task |
| Inbox row | 4 (row, Review material & decide, Approve, confirm) | the exact action in the row |
| Task decision card | 3 (Review material & decide, Approve, confirm) | action, target and material version |

The operator CLI is outside the budget: it has no screens.

## Recovery

- Material that changed since the request was read shows "Version n is out of date"
  and requires a fresh read before deciding.
- Denial persists; a replayed decision cannot apply twice.
- A dependency, source or recovery hold stays after approval and is shown with it.
