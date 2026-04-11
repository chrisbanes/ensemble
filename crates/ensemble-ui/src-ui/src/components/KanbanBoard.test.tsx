import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import KanbanBoard from './KanbanBoard';

describe('KanbanBoard', () => {
  const mockData = {
    running: [],
    retrying: [],
    waiting_on_human: [],
    counts: { running: 0, retrying: 0, waiting_on_human: 0 },
    agent_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    poll_interval_ms: 30000,
  };

  it('renders columns', () => {
    render(<KanbanBoard data={mockData as any} />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Retrying')).toBeInTheDocument();
  });
});
