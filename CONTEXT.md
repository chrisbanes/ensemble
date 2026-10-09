# Ensemble

Ensemble coordinates agents working on tasks within projects. Agents decide
how work proceeds; Ensemble owns durable coordination.

## Language

**Attention inbox**:
A cross-project collection of unresolved questions, approvals and problems requiring operator action.
Routine progress and completed work that needs no decision belong outside this inbox.
_Avoid_: Notification feed or conversation history

**Project**:
A container for tasks, optional linked repositories, agent profiles, instructions, and permissions.
Its identity belongs to Ensemble and is independent of the application hosting it.
_Avoid_: Board or GitHub Project when referring to the Ensemble container

**Task**:
A piece of work belonging to one project, created locally or linked to an external item.
_Avoid_: Issue when referring to work independently of its external provider

**Task dependency**:
A directed relationship in which a task's work depends on another task or an
external work item. It is distinct from readiness, source membership, and
dependencies between assignments within a task.
_Avoid_: Assignment dependency when referring to a relationship between tasks

**Task source**:
A project-scoped origin of tasks: built-in local creation or a configured external source supplied by a plugin.
_Avoid_: Project when referring to a source such as a GitHub Project

**External reference**:
The stable identity of a task's corresponding item in an external system, independent of which sources discover it.
_Avoid_: Source configuration when referring to external task identity

**Project lead**:
The agent accountable for task outcomes across a project, including coordination,
planning and allocation exceptions. Delegating work does not transfer that accountability.
_Avoid_: Task owner as a separate accountability role

**Agent profile**:
A reusable, operator-defined identity and instructions, selected for project leads and task assignments. Its execution settings are validated for the selected runtime.
_Avoid_: Bot identity or assignment when referring to reusable configuration

**Assignment**:
A durable unit of work delegated to an agent within a task that can continue across agent conversations.
_Avoid_: Step when referring to delegated work

**Assignment assignee**:
The agent tasked with carrying out an assignment and returning its result.
_Avoid_: Task owner when referring to the agent executing an assignment

**Follow-up**:
An explicit request that continues a completed assignment with new instructions,
keeping its identity and history as newer work. An operator follow-up sends
feedback to a task's completed project lead while the task is still open; it
never reopens a done task.
_Avoid_: Reassignment or a new assignment when the same assignment continues

**Agent conversation**:
The interaction history used by an agent to carry out work. An assignment can continue across replacement conversations.
_Avoid_: Assignment when referring only to its conversation history

**Execution runtime**:
The agent harness or execution engine that carries out admitted agent turns and
reports their observations to Ensemble.
_Avoid_: Scheduler when referring to the system executing one agent turn

**Execution binding**:
The association between an assignment and its runtime-specific session or process
identity and validated execution settings.
_Avoid_: Assignment identity when referring only to an execution session

**Task workspace**:
The working files allocated to a task, retained independently of its conversations.
_Avoid_: Conversation when referring to a task's working files

**Current workspace contents**:
The files observed in a task workspace at an identified inspection time. They may
change as work continues and do not represent a historical result.
_Avoid_: Result revision when referring to the files currently present

**Retained result evidence**:
The bounded file contents and diffs preserved for a particular recorded result,
remaining attributable to it after the task workspace changes or is removed.
It is not a snapshot of the whole task workspace.
_Avoid_: Workspace snapshot when referring only to result-linked evidence

**Code review**:
A batch of operator line comments and an optional summary sent together to a
task's accountable project lead. It is local feedback, not a GitHub review or
an approval or completion decision.
_Avoid_: Approval when referring to submitted review feedback

**Review anchor**:
The exact task, repository/file content, line range and applicable diff side
that a review comment addresses. Later file changes do not move the anchor.
_Avoid_: Current line number when referring to historical reviewed content

**Local review**:
A code review composed and sent inside Ensemble, with no GitHub involvement.
It is delivered to the accountable project lead as one operator message.
_Avoid_: Pull request review

**Review draft**:
The unsent summary, comments and anchor groups an operator session is composing
for a task. It belongs to that session and is frozen while sending and once sent.
_Avoid_: Saved review when referring to unsent text

**Anchor group**:
The review anchors captured together for one comment, kept or discarded as a
unit. Sending seals the groups into submitted context.
_Avoid_: Selection when referring to the retained, sealed anchors

**Review operation**:
One frozen send of a review draft, identified by the operator's command key. It
ends as recorded (the message was queued), rejected (definitively not sent) or
not-recorded (fenced by reconciliation); until then it is prepared and its
outcome is unknown.
_Avoid_: Delivery when the outcome is unknown or not recorded
