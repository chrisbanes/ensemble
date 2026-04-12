import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import KanbanBoard from './KanbanBoard';

describe('KanbanBoard', () => {
  const mockData = {
    running: [],
    retrying: [],
    waiting_on_human: [],
    counts: { running: 0, retrying: 0, waiting_on_human: 0, completed: 0 },
    agent_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    poll_interval_ms: 30000,
  };

  it('renders columns', () => {
    render(
      <BrowserRouter>
        <KanbanBoard data={mockData as any} />
      </BrowserRouter>
    );
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Retrying')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('renders completed issues when provided', () => {
    const data = {
      ...mockData,
      completed: [
        {
          issue_id: 'NODE_123',
          issue_identifier: 'repo#123',
          status: 'completed_succeeded',
          completed_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    render(
      <BrowserRouter>
        <KanbanBoard data={data as any} />
      </BrowserRouter>
    );

    expect(screen.getByText('repo#123')).toBeInTheDocument();
  });
});
