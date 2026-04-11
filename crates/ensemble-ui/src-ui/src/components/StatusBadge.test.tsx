import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('renders completed_succeeded', () => {
    render(<StatusBadge status="completed_succeeded" />);
    expect(screen.getByText('completed_succeeded')).toBeInTheDocument();
  });

  it('renders completed_failed', () => {
    render(<StatusBadge status="completed_failed" />);
    expect(screen.getByText('completed_failed')).toBeInTheDocument();
  });

  it('renders completed_stopped', () => {
    render(<StatusBadge status="completed_stopped" />);
    expect(screen.getByText('completed_stopped')).toBeInTheDocument();
  });
});
