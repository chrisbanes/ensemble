import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type Tab = 'Workflow' | 'Logs' | 'Artifacts' | 'Raw events';

interface IssueContextPanelProps {
  workflow: ReactNode;
  logs: ReactNode;
  artifacts: ReactNode;
  rawEvents: ReactNode;
}

const tabs: Tab[] = ['Workflow', 'Logs', 'Artifacts', 'Raw events'];

export function IssueContextPanel({ workflow, logs, artifacts, rawEvents }: IssueContextPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('Workflow');

  const content =
    activeTab === 'Workflow'
      ? workflow
      : activeTab === 'Logs'
        ? logs
        : activeTab === 'Artifacts'
          ? artifacts
          : rawEvents;

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card">
      <div className="flex gap-2 border-b p-2" role="tablist" aria-label="Issue context tabs">
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
