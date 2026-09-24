# Ensemble

Ensemble coordinates agents working across issue tracker boards. Agents decide
how work proceeds; Ensemble owns durable coordination and execution.

## Language

**Tracker**:
An external system that holds issues and their shared work records.
_Avoid_: Board when referring to the source system

**Issue**:
A unit of work identified within a tracker, which may appear in multiple boards.
_Avoid_: Assignment when referring to the tracker work item

**Board**:
A configured work queue from one tracker, with its own lead, instructions, and permissions.
_Avoid_: Tracker when referring to a selected queue

**Board lead**:
The agent responsible for selecting and delegating work across a board.
_Avoid_: Issue owner when referring to board-wide responsibility

**Issue owner**:
The agent responsible for coordinating an issue's work and bringing it to an outcome.
_Avoid_: Board lead when referring to responsibility for one issue

**Agent profile**:
An operator-defined configuration of an agent's instructions, model, and available tools.
_Avoid_: Assignment when referring to a reusable agent configuration

**Assignment**:
A durable unit of delegated work within a board that can continue across agent conversations.
_Avoid_: Step when referring to delegated work
