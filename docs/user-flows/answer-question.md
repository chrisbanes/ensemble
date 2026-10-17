# Answer a question

**Status:** planned. The Inbox, Home card and task decision card answer questions
today; the budget below is not yet asserted by a journey test.

## Goal

The operator sees what is being asked before opening anything, answers it where
they are, and gets one confirmation that the answer was recorded.

## Entry points

- Home "Needs you" card.
- Inbox queue row.
- Task detail decision card.
- Browser notification (opt-in, Settings → Notifications): opens the exact Inbox
  selection after sign-in. It is outside the budget below, and it never answers.
- Operator CLI `question answer`.

## Steps

1. The list row or card shows the question itself (the first question's label), the
   task and project beneath it, the requester when known, and Answer question.
2. The form shows the questions in the request's order with their constraints and
   any recommended option marked as a draft, not an answer. A single-choice question
   on the Home card is answerable there.
3. Submit answer records the whole group once and shows "Answer recorded" with the
   request still in view. The Inbox does not move to the next request on its own.

## Budget

| Entry point | Interactions to a recorded answer | First screen must show |
| --- | --- | --- |
| Home card, single choice | 2 (choose, Submit) | the question text and its options |
| Inbox row | 3 (row, choose, Submit) | the question text in the row |
| Task decision card | 3 (Answer question, choose, Submit) | the question text on the card |

The operator CLI is outside the budget: it has no screens.

## Recovery

- A failed submission keeps the input and names the cause; a stale or already
  answered request refuses a new answer and says so.
- Recording an answer never resumes a paused project or clears a hold; the
  confirmation states any remaining wait, with its Fix where the
  [specification](../SPEC.md#task-creation-and-project-setup) gives it one and
  otherwise with the link to what blocks it.
- An unsupported runtime request stays unresolved and is never converted to chat.
