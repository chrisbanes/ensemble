# Ensemble

Ensemble coordinates agents working on tasks within projects. Agents decide
how work proceeds; Ensemble owns durable coordination.

## Language

**Project**:
A container for tasks, optional linked repositories, agent profiles, instructions, and permissions.
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
The agent responsible for selecting and delegating work across a project.
_Avoid_: Task owner when referring to project-wide responsibility

**Task owner**:
The agent responsible for coordinating a task's work and bringing it to an outcome.
_Avoid_: Project lead when referring to responsibility for one task

**Agent profile**:
A reusable, operator-defined configuration of instructions, provider, model, and available tools, selected for project leads and task assignments.
_Avoid_: Bot identity or assignment when referring to reusable configuration

**Assignment**:
A durable unit of work delegated to an agent within a task that can continue across agent conversations.
_Avoid_: Step when referring to delegated work

**Agent conversation**:
The interaction history used by an agent to carry out work. An assignment can continue across replacement conversations.
_Avoid_: Assignment when referring only to its conversation history
