# Control Room Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split issue detail surfaces with a merged typed run transcript, pinned composer, and supporting context panel while preserving existing backend behavior.

**Architecture:** Build a frontend-only transcript normalization layer that merges conversation, interaction, and timeline/live event sources into a single `TranscriptEntry[]` model. Render the issue detail page from that merged model using typed entry components, keep low-level activity collapsed by default, and move timeline/raw details into a supporting context panel.

**Tech Stack:** React, TypeScript, Vite, existing Ensemble UI components/hooks, React Router, generated API models, websocket live updates, Vitest + Testing Library.

---

## File Structure

### Existing files to modify
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` — replace the current three-panel assembly with the new shell layout and wire the transcript/composer/context panel.
- `crates/ensemble-ui/src-ui/src/components/ConversationViewer.tsx` — retire or reduce to a thin compatibility wrapper once the new transcript replaces it.
- `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx` — reduce to a raw-events supporting panel component or adapt for the new context panel.
- `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx` — retire or reduce to question-banner/composer-specific pieces.
- `crates/ensemble-ui/src-ui/src/hooks.ts` and/or `crates/ensemble-ui/src-ui/src/hooks/*` — expose any small helper hooks needed by the new shell if existing queries need composition.

### New files to create
- `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts` — `TranscriptEntry` types, normalization, ordering, and grouping rules.
- `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts` — unit tests for merge ordering and grouped low-level activity.
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx` — virtual-scroll-ready transcript list container (plain rendering first, no virtualization yet).
- `crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx` — entry-type dispatch.
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/AgentMessageEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/HumanMessageEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/AgentQuestionEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/HumanReplyEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/StepEventEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/VerdictEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/ToolActivityGroupEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/entries/ErrorEntry.tsx`
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.tsx` — pinned bottom composer with question/follow-up modes.
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueQuestionBanner.tsx` — blocked-question summary above the composer.
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.tsx` — supporting tabs for workflow/logs/artifacts/raw events.
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.test.tsx`
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.test.tsx`
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx` — integration coverage for the new page behavior.

### Boundaries
- Keep normalization logic out of React components.
- Keep typed entry rendering separate from shell layout.
- Keep the composer independent from transcript normalization so reply UX can evolve without reworking entry ordering logic.
- Keep raw-event presentation in the context panel rather than mixing raw detail rendering into primary transcript entry components.

---

### Task 1: Build transcript types and normalization model

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`

- [ ] **Step 1: Write the failing normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildTranscriptEntries,
  groupTranscriptEntries,
  type TranscriptSource,
} from './transcript-model';

describe('buildTranscriptEntries', () => {
  it('merges messages, interaction items, and timeline events into one ordered stream', () => {
    const source: TranscriptSource = {
      conversation: [
        {
          index: 10,
          role: 'assistant',
          content: 'I need the API key.',
          tool_calls: null,
        },
      ],
      interaction: {
        id: 'ask-1',
        status: 'pending',
        question: 'What API key should I use?',
        why_blocked: 'Deployment requires credentials',
        suggested_answer: 'Use staging key',
        extra_context: null,
        step_name: 'deploy',
        requested_at: '2026-04-14T10:00:02Z',
        resolved_at: null,
      },
      events: [
        {
          type: 'step_started',
          timestamp: '2026-04-14T10:00:00Z',
          detail: 'Started deploy',
          stepName: 'deploy',
          runId: 'run-1',
          sequence: 1,
        },
        {
          type: 'verdict',
          timestamp: '2026-04-14T10:00:04Z',
          detail: 'approved',
          verdict: 'pass',
          stepName: 'deploy',
          runId: 'run-1',
          sequence: 4,
        },
      ],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'step_event',
      'agent_question',
      'agent_message',
      'verdict',
    ]);
  });

  it('collapses adjacent low-level activity into one grouped entry', () => {
    const source: TranscriptSource = {
      conversation: [],
      interaction: null,
      events: [
        {
          type: 'tool_call',
          timestamp: '2026-04-14T10:00:00Z',
          detail: 'rg src',
          runId: 'run-1',
          sequence: 1,
        },
        {
          type: 'output',
          timestamp: '2026-04-14T10:00:01Z',
          detail: 'match 1',
          runId: 'run-1',
          sequence: 2,
        },
        {
          type: 'output',
          timestamp: '2026-04-14T10:00:02Z',
          detail: 'match 2',
          runId: 'run-1',
          sequence: 3,
        },
      ],
    };

    const entries = groupTranscriptEntries(buildTranscriptEntries(source));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_activity_group',
      defaultExpanded: false,
      count: 3,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts`
Expected: FAIL with module not found or missing `buildTranscriptEntries` / `groupTranscriptEntries` exports.

- [ ] **Step 3: Write the minimal transcript model implementation**

```ts
import type { ConversationMessage, InteractionDetail } from '@/generated/models';
import type { WsEventData } from '@/ws-types';

export type TranscriptEntry =
  | {
      id: string;
      kind: 'agent_message' | 'human_message';
      timestamp: string;
      sortKey: [number, number, number];
      messageIndex: number;
      content: string;
      toolCalls: unknown;
    }
  | {
      id: string;
      kind: 'agent_question';
      timestamp: string;
      sortKey: [number, number, number];
      question: string;
      whyBlocked: string | null;
      suggestedAnswer: string | null;
      stepName: string | null;
      interactionId: string;
    }
  | {
      id: string;
      kind: 'step_event' | 'verdict' | 'error' | 'workflow_event';
      timestamp: string;
      sortKey: [number, number, number];
      eventType: string;
      detail: string;
      stepName: string | null;
      runId: string | null;
      sequence: number | null;
    }
  | {
      id: string;
      kind: 'tool_activity_group';
      timestamp: string;
      sortKey: [number, number, number];
      summary: string;
      count: number;
      defaultExpanded: false;
      items: TranscriptEntry[];
    };

export interface TranscriptSource {
  conversation: ConversationMessage[];
  interaction: InteractionDetail | null;
  events: WsEventData[];
}

function toMillis(value: string | undefined): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function eventKind(event: WsEventData): TranscriptEntry['kind'] {
  if (event.type === 'verdict') return 'verdict';
  if (event.type === 'error') return 'error';
  if (event.type === 'step_started' || event.type === 'step_completed') {
    return 'step_event';
  }
  return 'workflow_event';
}

export function buildTranscriptEntries(source: TranscriptSource): TranscriptEntry[] {
  const conversationEntries: TranscriptEntry[] = source.conversation.map((message) => ({
    id: `message-${message.index}`,
    kind: message.role === 'user' ? 'human_message' : 'agent_message',
    timestamp: new Date(0).toISOString(),
    sortKey: [0, 1, message.index],
    messageIndex: message.index,
    content: message.content,
    toolCalls: message.tool_calls,
  }));

  const interactionEntries: TranscriptEntry[] = source.interaction
    ? [
        {
          id: `interaction-${source.interaction.id}`,
          kind: 'agent_question',
          timestamp: source.interaction.requested_at,
          sortKey: [toMillis(source.interaction.requested_at), 0, 0],
          question: source.interaction.question,
          whyBlocked: source.interaction.why_blocked,
          suggestedAnswer: source.interaction.suggested_answer,
          stepName: source.interaction.step_name,
          interactionId: source.interaction.id,
        },
      ]
    : [];

  const eventEntries: TranscriptEntry[] = source.events.map((event, index) => ({
    id: `event-${event.runId ?? 'none'}-${event.sequence ?? index}`,
    kind: eventKind(event),
    timestamp: event.timestamp,
    sortKey: [toMillis(event.timestamp), 0, event.sequence ?? index],
    eventType: event.type,
    detail: event.detail,
    stepName: event.stepName ?? null,
    runId: event.runId ?? null,
    sequence: event.sequence ?? null,
  }));

  return [...conversationEntries, ...interactionEntries, ...eventEntries].sort((a, b) => {
    const [a0, a1, a2] = a.sortKey;
    const [b0, b1, b2] = b.sortKey;
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
}

export function groupTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  let buffer: TranscriptEntry[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      result.push(buffer[0]!);
      buffer = [];
      return;
    }

    result.push({
      id: `group-${buffer[0]!.id}`,
      kind: 'tool_activity_group',
      timestamp: buffer[0]!.timestamp,
      sortKey: buffer[0]!.sortKey,
      summary: `${buffer.length} low-level activity items`,
      count: buffer.length,
      defaultExpanded: false,
      items: buffer,
    });
    buffer = [];
  };

  for (const entry of entries) {
    const isLowLevel =
      entry.kind === 'workflow_event' &&
      'eventType' in entry &&
      (entry.eventType === 'tool_call' || entry.eventType === 'output');

    if (isLowLevel) {
      buffer.push(entry);
    } else {
      flush();
      result.push(entry);
    }
  }

  flush();
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts`
Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts \
  crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts
git commit -m "feat: add transcript normalization model"
```

### Task 2: Add typed transcript entry renderers

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/AgentMessageEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/HumanMessageEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/AgentQuestionEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/HumanReplyEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/StepEventEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/VerdictEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/ToolActivityGroupEntry.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/entries/ErrorEntry.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Write the failing transcript rendering test**

```tsx
import { render, screen } from '@/test/render';
import { describe, expect, it } from 'vitest';
import { RunTranscript } from '@/components/transcript/RunTranscript';
import type { TranscriptEntry } from '@/components/transcript/transcript-model';

describe('RunTranscript', () => {
  it('renders high-signal entries and collapsed low-level summaries', () => {
    const entries: TranscriptEntry[] = [
      {
        id: 'question-1',
        kind: 'agent_question',
        timestamp: '2026-04-14T10:00:00Z',
        sortKey: [1, 0, 0],
        question: 'Which environment?',
        whyBlocked: 'Need deployment target',
        suggestedAnswer: 'Use staging',
        stepName: 'deploy',
        interactionId: 'ask-1',
      },
      {
        id: 'group-1',
        kind: 'tool_activity_group',
        timestamp: '2026-04-14T10:00:01Z',
        sortKey: [2, 0, 0],
        summary: 'Ran 4 tools',
        count: 4,
        defaultExpanded: false,
        items: [],
      },
    ];

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.getByText('Which environment?')).toBeInTheDocument();
    expect(screen.getByText('Ran 4 tools')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: FAIL because `RunTranscript` and typed entry components do not exist yet.

- [ ] **Step 3: Write minimal renderer and entry components**

```tsx
// crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx
import { TranscriptEntryRenderer } from './TranscriptEntryRenderer';
import type { TranscriptEntry } from './transcript-model';

interface RunTranscriptProps {
  entries: TranscriptEntry[];
  activeEntryId: string | null;
  onJumpToEntry: (entryId: string) => void;
}

export function RunTranscript({ entries, activeEntryId, onJumpToEntry }: RunTranscriptProps) {
  if (entries.length === 0) {
    return <div className="py-8 text-center text-muted-foreground">No transcript activity yet.</div>;
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <TranscriptEntryRenderer
          key={entry.id}
          entry={entry}
          isActive={entry.id === activeEntryId}
          onJumpToEntry={onJumpToEntry}
        />
      ))}
    </div>
  );
}
```

```tsx
// crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx
import { AgentMessageEntry } from './entries/AgentMessageEntry';
import { AgentQuestionEntry } from './entries/AgentQuestionEntry';
import { ErrorEntry } from './entries/ErrorEntry';
import { HumanMessageEntry } from './entries/HumanMessageEntry';
import { HumanReplyEntry } from './entries/HumanReplyEntry';
import { StepEventEntry } from './entries/StepEventEntry';
import { ToolActivityGroupEntry } from './entries/ToolActivityGroupEntry';
import { VerdictEntry } from './entries/VerdictEntry';
import type { TranscriptEntry } from './transcript-model';

interface TranscriptEntryRendererProps {
  entry: TranscriptEntry;
  isActive: boolean;
  onJumpToEntry: (entryId: string) => void;
}

export function TranscriptEntryRenderer({ entry, isActive, onJumpToEntry }: TranscriptEntryRendererProps) {
  switch (entry.kind) {
    case 'agent_message':
      return <AgentMessageEntry entry={entry} isActive={isActive} />;
    case 'human_message':
      return <HumanMessageEntry entry={entry} isActive={isActive} />;
    case 'agent_question':
      return <AgentQuestionEntry entry={entry} isActive={isActive} onJumpToEntry={onJumpToEntry} />;
    case 'human_reply':
      return <HumanReplyEntry entry={entry} isActive={isActive} />;
    case 'step_event':
    case 'workflow_event':
      return <StepEventEntry entry={entry} isActive={isActive} />;
    case 'verdict':
      return <VerdictEntry entry={entry} isActive={isActive} />;
    case 'tool_activity_group':
      return <ToolActivityGroupEntry entry={entry} isActive={isActive} />;
    case 'error':
      return <ErrorEntry entry={entry} isActive={isActive} />;
    default:
      return null;
  }
}
```

```tsx
// Representative entry component shape, repeat per file with entry-specific labels/styles
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { TranscriptEntry } from '../transcript-model';

export function AgentQuestionEntry({
  entry,
  isActive,
}: {
  entry: Extract<TranscriptEntry, { kind: 'agent_question' }>;
  isActive: boolean;
  onJumpToEntry?: (entryId: string) => void;
}) {
  return (
    <Card className={cn('border-blue-300 bg-blue-50/60 p-4', isActive && 'ring-2 ring-primary')}>
      <div className="text-xs font-medium uppercase text-blue-700">Agent question</div>
      <div className="mt-1 text-sm font-semibold">{entry.question}</div>
      {entry.whyBlocked ? <p className="mt-2 text-sm text-muted-foreground">{entry.whyBlocked}</p> : null}
      {entry.suggestedAnswer ? <p className="mt-2 text-sm">Suggested: {entry.suggestedAnswer}</p> : null}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: PASS with the transcript rendering test green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
git commit -m "feat: add typed transcript entry renderers"
```

### Task 3: Build the pinned composer and question banner

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueQuestionBanner.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx` (reduce or reuse shared UI only if useful)
- Test: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.test.tsx`

- [ ] **Step 1: Write the failing composer-mode test**

```tsx
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IssueComposer } from './IssueComposer';

describe('IssueComposer', () => {
  it('renders question mode when a pending interaction exists', async () => {
    const user = userEvent.setup();
    const onSubmitReply = vi.fn();

    render(
      <IssueComposer
        pendingQuestion={{
          interactionId: 'ask-1',
          question: 'Which API key?',
          whyBlocked: 'Deploy is blocked',
          suggestedAnswer: 'Use staging',
          stepName: 'deploy',
        }}
        onSubmitReply={onSubmitReply}
        onSubmitFollowUp={vi.fn()}
        isSubmitting={false}
      />
    );

    expect(screen.getByText('Which API key?')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reply'), 'Use staging key');
    await user.click(screen.getByRole('button', { name: 'Submit Reply' }));

    expect(onSubmitReply).toHaveBeenCalledWith('Use staging key');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/issue-detail/IssueComposer.test.tsx`
Expected: FAIL because `IssueComposer` does not exist.

- [ ] **Step 3: Write the minimal composer implementation**

```tsx
import { useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IssueQuestionBanner } from './IssueQuestionBanner';

interface PendingQuestion {
  interactionId: string;
  question: string;
  whyBlocked: string | null;
  suggestedAnswer: string | null;
  stepName: string | null;
}

interface IssueComposerProps {
  pendingQuestion: PendingQuestion | null;
  onSubmitReply: (value: string) => void;
  onSubmitFollowUp: (value: string) => void;
  isSubmitting: boolean;
}

export function IssueComposer({ pendingQuestion, onSubmitReply, onSubmitFollowUp, isSubmitting }: IssueComposerProps) {
  const [value, setValue] = useState('');
  const isQuestionMode = pendingQuestion !== null;

  return (
    <div className="border-t bg-background p-4 space-y-3">
      {pendingQuestion ? <IssueQuestionBanner pendingQuestion={pendingQuestion} /> : null}
      <label htmlFor="issue-composer" className="text-sm font-medium">
        {isQuestionMode ? 'Reply' : 'Follow-up'}
      </label>
      <Textarea
        id="issue-composer"
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
        placeholder={isQuestionMode ? 'Answer the agent question' : 'Add operator guidance'}
      />
      <div className="flex gap-2">
        <Button
          onClick={() => {
            if (isQuestionMode) {
              onSubmitReply(value);
            } else {
              onSubmitFollowUp(value);
            }
            setValue('');
          }}
          disabled={isSubmitting || value.trim().length === 0}
        >
          {isQuestionMode ? 'Submit Reply' : 'Send Follow-up'}
        </Button>
      </div>
    </div>
  );
}
```

```tsx
import { Card } from '@/components/ui/card';

export function IssueQuestionBanner({ pendingQuestion }: {
  pendingQuestion: {
    question: string;
    whyBlocked: string | null;
    suggestedAnswer: string | null;
    stepName: string | null;
  };
}) {
  return (
    <Card className="border-blue-300 bg-blue-50/60 p-3">
      <div className="text-xs font-medium uppercase text-blue-700">Waiting for human input</div>
      <div className="mt-1 font-semibold">{pendingQuestion.question}</div>
      {pendingQuestion.whyBlocked ? <p className="mt-1 text-sm text-muted-foreground">{pendingQuestion.whyBlocked}</p> : null}
      {pendingQuestion.suggestedAnswer ? <p className="mt-1 text-sm">Suggested: {pendingQuestion.suggestedAnswer}</p> : null}
      {pendingQuestion.stepName ? <p className="mt-1 text-xs text-muted-foreground">Step: {pendingQuestion.stepName}</p> : null}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/issue-detail/IssueComposer.test.tsx`
Expected: PASS with the question-mode reply flow green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.tsx \
  crates/ensemble-ui/src-ui/src/components/issue-detail/IssueQuestionBanner.tsx \
  crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.test.tsx
git commit -m "feat: add issue detail composer"
```

### Task 4: Add supporting context panel for workflow and raw details

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.test.tsx`

- [ ] **Step 1: Write the failing context-panel tab test**

```tsx
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { IssueContextPanel } from './IssueContextPanel';

describe('IssueContextPanel', () => {
  it('switches between workflow and raw events tabs', async () => {
    const user = userEvent.setup();

    render(
      <IssueContextPanel
        workflow={<div>workflow graph</div>}
        logs={<div>log output</div>}
        artifacts={<div>artifact list</div>}
        rawEvents={<div>raw timeline</div>}
      />
    );

    expect(screen.getByText('workflow graph')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Raw events' }));
    expect(screen.getByText('raw timeline')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/issue-detail/IssueContextPanel.test.tsx`
Expected: FAIL because `IssueContextPanel` does not exist.

- [ ] **Step 3: Write the minimal tabbed context panel**

```tsx
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface IssueContextPanelProps {
  workflow: ReactNode;
  logs: ReactNode;
  artifacts: ReactNode;
  rawEvents: ReactNode;
}

const tabs = ['Workflow', 'Logs', 'Artifacts', 'Raw events'] as const;
type Tab = (typeof tabs)[number];

export function IssueContextPanel({ workflow, logs, artifacts, rawEvents }: IssueContextPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('Workflow');

  const content =
    activeTab === 'Workflow' ? workflow :
    activeTab === 'Logs' ? logs :
    activeTab === 'Artifacts' ? artifacts :
    rawEvents;

  return (
    <div className="flex h-full flex-col border rounded-lg bg-card">
      <div className="flex gap-2 border-b p-2">
        {tabs.map((tab) => (
          <Button
            key={tab}
            type="button"
            variant={tab === activeTab ? 'default' : 'ghost'}
            role="tab"
            aria-selected={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </Button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3">{content}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/issue-detail/IssueContextPanel.test.tsx`
Expected: PASS with the tab switching behavior green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.tsx \
  crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.test.tsx
git commit -m "feat: add issue detail context panel"
```

### Task 5: Replace IssueDetail layout with transcript shell

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/ConversationViewer.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Write the failing page integration test**

```tsx
import { render, screen } from '@/test/render';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import IssueDetail from './IssueDetail';

vi.mock('@/hooks', () => ({
  useIssueDetailQuery: () => ({
    data: {
      issue_identifier: 'todo-1',
      status: 'running',
      running: {
        step_name: 'deploy',
        turn_count: 2,
        tokens: { total_tokens: 100 },
        run_id: 'run-1',
      },
      attempts: { restart_count: 0 },
      retry: null,
      last_error: null,
      issue: { title: 'Deploy feature' },
      workspace: { path: '/tmp/workspace' },
      workflow_steps: [],
      pending_input: { ask_id: 'ask-1' },
      current_interaction: { interaction_request_id: 'ask-1' },
    },
    isLoading: false,
    isError: false,
  }),
  useInteractionDetailQuery: () => ({
    data: {
      id: 'ask-1',
      status: 'pending',
      question: 'Which environment?',
      why_blocked: 'Need target',
      suggested_answer: 'staging',
      extra_context: null,
      step_name: 'deploy',
      requested_at: '2026-04-14T10:00:00Z',
      resolved_at: null,
    },
  }),
  useTimelineQuery: () => ({ data: { events: [] }, isError: false }),
  useConversationQuery: () => ({
    data: { messages: [{ index: 1, role: 'assistant', content: 'I am ready', tool_calls: null }] },
    isLoading: false,
    isError: false,
  }),
  useStopMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useIssueInputMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelInteractionMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/ws', () => ({ connectWs: () => () => {}, }));

describe('IssueDetail', () => {
  it('renders the merged transcript shell and composer', () => {
    render(
      <MemoryRouter initialEntries={['/issue/todo-1']}>
        <Routes>
          <Route path="/issue/:identifier" element={<IssueDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Which environment?')).toBeInTheDocument();
    expect(screen.getByText('I am ready')).toBeInTheDocument();
    expect(screen.getByLabelText('Reply')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Workflow' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: FAIL because the current page does not render the merged transcript shell.

- [ ] **Step 3: Rewrite `IssueDetail.tsx` around the new shell**

```tsx
// Outline only; fill in the full component with existing query + websocket logic preserved.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  useCancelInteractionMutation,
  useInteractionDetailQuery,
  useIssueDetailQuery,
  useIssueInputMutation,
  useRetryMutation,
  useStopMutation,
  useTimelineQuery,
} from '@/hooks';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/StatusBadge';
import { RunTranscript } from '@/components/transcript/RunTranscript';
import { buildTranscriptEntries, groupTranscriptEntries } from '@/components/transcript/transcript-model';
import { IssueComposer } from '@/components/issue-detail/IssueComposer';
import { IssueContextPanel } from '@/components/issue-detail/IssueContextPanel';
import EventTimeline from '@/components/EventTimeline';
import WorkflowStepsSidebar from '@/components/WorkflowStepsSidebar';

export default function IssueDetail() {
  const { identifier = '' } = useParams<{ identifier: string }>();
  const { data, isLoading, isError, error } = useIssueDetailQuery(identifier);
  const interactionId =
    data?.pending_input?.ask_id ?? data?.current_interaction?.interaction_request_id ?? '';
  const { data: interaction } = useInteractionDetailQuery(interactionId);
  const timelineQuery = useTimelineQuery(identifier, data?.running?.run_id ?? '');
  const stopMutation = useStopMutation();
  const retryMutation = useRetryMutation();
  const inputMutation = useIssueInputMutation(identifier, interactionId);
  const cancelMutation = useCancelInteractionMutation(identifier);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);

  const transcriptEntries = useMemo(() => {
    const source = {
      conversation: [], // replace with conversation query in full implementation
      interaction: interaction ?? null,
      events: [], // replace with normalized persisted/live events in full implementation
    };
    return groupTranscriptEntries(buildTranscriptEntries(source));
  }, [interaction]);

  if (isLoading) return <div className="py-12 text-center text-muted-foreground">Loading...</div>;
  if (isError) {
    return <div className="py-12 text-center text-destructive">Failed to load issue: {error instanceof Error ? error.message : 'Unknown error'}</div>;
  }
  if (!data) return null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-bold">{data.issue_identifier}</h1>
          <StatusBadge status={data.status} />
          <span className="text-sm text-muted-foreground">Step: {data.running?.step_name ?? '—'}</span>
        </div>
        <div className="flex gap-2">
          {data.running ? <Button variant="destructive" size="sm" onClick={() => stopMutation.mutate({ identifier })}>Stop Agent</Button> : null}
          {data.retry ? <Button size="sm" onClick={() => retryMutation.mutate({ identifier })}>Retry Now</Button> : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex min-h-0 flex-col rounded-lg border bg-card">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <RunTranscript
              entries={transcriptEntries}
              activeEntryId={activeEntryId}
              onJumpToEntry={setActiveEntryId}
            />
          </div>
          <IssueComposer
            pendingQuestion={interaction ? {
              interactionId: interaction.id,
              question: interaction.question,
              whyBlocked: interaction.why_blocked,
              suggestedAnswer: interaction.suggested_answer,
              stepName: interaction.step_name,
            } : null}
            onSubmitReply={(value) => inputMutation.mutate(value)}
            onSubmitFollowUp={(value) => inputMutation.mutate(value)}
            isSubmitting={inputMutation.isPending}
          />
        </div>

        <IssueContextPanel
          workflow={
            <WorkflowStepsSidebar
              steps={data.workflow_steps ?? []}
              issueIdentifier={identifier}
              currentStep={data.running?.step_name ?? undefined}
            />
          }
          logs={<div className="text-sm text-muted-foreground">Log view comes from grouped transcript/raw events in later tasks.</div>}
          artifacts={<div className="text-sm text-muted-foreground">Artifact summaries land here when available.</div>}
          rawEvents={<EventTimeline events={[]} live={Boolean(data.running)} onViewConversation={() => {}} />}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: PASS with the merged shell integration test green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx \
  crates/ensemble-ui/src-ui/src/components/ConversationViewer.tsx \
  crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx \
  crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx
git commit -m "feat: redesign issue detail around merged transcript"
```

### Task 6: Finish jump/highlight behavior and supporting polish

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/entries/ToolActivityGroupEntry.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Write the failing highlight/expand behavior test**

```tsx
it('highlights the active transcript entry and expands grouped activity on demand', async () => {
  const user = userEvent.setup();
  render(
    <RunTranscript
      entries={[
        {
          id: 'group-1',
          kind: 'tool_activity_group',
          timestamp: '2026-04-14T10:00:00Z',
          sortKey: [1, 0, 0],
          summary: 'Ran 2 tools',
          count: 2,
          defaultExpanded: false,
          items: [
            {
              id: 'event-1',
              kind: 'workflow_event',
              timestamp: '2026-04-14T10:00:00Z',
              sortKey: [1, 0, 1],
              eventType: 'tool_call',
              detail: 'rg src',
              stepName: 'build',
              runId: 'run-1',
              sequence: 1,
            },
          ],
        },
      ]}
      activeEntryId="group-1"
      onJumpToEntry={() => {}}
    />
  );

  expect(screen.getByText('Ran 2 tools').closest('[data-active="true"]')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('rg src')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: FAIL because grouped entries do not expand/highlight yet.

- [ ] **Step 3: Add active/highlight and expand-on-demand behavior**

```tsx
// In ToolActivityGroupEntry.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { TranscriptEntry } from '../transcript-model';

export function ToolActivityGroupEntry({
  entry,
  isActive,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool_activity_group' }>;
  isActive: boolean;
}) {
  const [expanded, setExpanded] = useState(entry.defaultExpanded);

  return (
    <Card className={cn('p-3', isActive && 'ring-2 ring-primary')} data-active={isActive ? 'true' : 'false'}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{entry.summary}</div>
          <div className="text-xs text-muted-foreground">{entry.count} items</div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2 border-t pt-3">
          {entry.items.map((item) => (
            <div key={item.id} className="rounded border bg-muted/20 p-2 text-xs">
              {'detail' in item ? item.detail : item.kind}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx`
Expected: PASS with the highlight/expand behavior green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/entries/ToolActivityGroupEntry.tsx \
  crates/ensemble-ui/src-ui/src/components/issue-detail/IssueContextPanel.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
git commit -m "feat: polish transcript interaction behavior"
```

### Task 7: Run verification and document any follow-up gaps

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-control-room-transcript-design.md` (only if implementation reveals a necessary design correction)
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Run focused frontend tests**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts src/components/issue-detail/IssueComposer.test.tsx src/components/issue-detail/IssueContextPanel.test.tsx src/pages/IssueDetail.test.tsx`
Expected: PASS with all transcript-shell tests green.

- [ ] **Step 2: Run the broader frontend suite**

Run: `cd crates/ensemble-ui/src-ui && pnpm test`
Expected: PASS with no regressions in existing UI tests.

- [ ] **Step 3: Run the frontend build**

Run: `cd crates/ensemble-ui/src-ui && pnpm run build`
Expected: PASS with a production build emitted and no TypeScript/Vite errors.

- [ ] **Step 4: Capture implementation follow-ups if any test or UX gap remains**

```md
- If transcript virtualization is still needed after real data testing, write a follow-up spec/plan rather than sneaking it into this task.
- If backend APIs prove insufficient to build reliable merged ordering, document the exact missing fields and open a follow-up design task.
```

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui docs/superpowers/specs/2026-04-14-control-room-transcript-design.md
git commit -m "test: verify control room transcript redesign"
```

---

## Self-Review

### Spec coverage
- **Merged activity stream:** covered by Tasks 1, 2, and 5.
- **Broader shell where helpful:** covered by Tasks 3, 4, and 5.
- **Collapsed low-level activity by default:** covered by Tasks 1, 2, and 6.
- **Question-first blocked UI:** covered by Task 3 and wired into Task 5.
- **Supporting workflow/log/artifact/raw detail access:** covered by Task 4 and Task 5.
- **Incremental frontend-first delivery:** enforced by Tasks 1 through 5 without backend changes.

### Placeholder scan
- Removed vague “do later” language from tasks and turned verification into explicit commands.
- Any future virtualization/backend work is explicitly deferred into documented follow-up notes instead of left as implied work.

### Type consistency
- The plan consistently uses `TranscriptEntry`, `buildTranscriptEntries`, `groupTranscriptEntries`, `RunTranscript`, `IssueComposer`, and `IssueContextPanel` across all tasks.

