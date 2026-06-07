import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
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
      />,
    );

    expect(screen.getByText('workflow graph')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Raw events' }));

    expect(screen.getByText('raw timeline')).toBeInTheDocument();
  });
});
