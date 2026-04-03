import { useState, useEffect, useRef, useCallback } from "react";
import type { DiscoveredAgentInfo } from "@/generated/models";

interface UseAgentDiscoveryOptions {
  enabled?: boolean;
}

interface UseAgentDiscoveryResult {
  agents: DiscoveredAgentInfo[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isComplete: boolean;
  retry: () => void;
}

/**
 * Hook for progressive agent discovery using Server-Sent Events.
 * Agents are added to the list as they're discovered, providing immediate feedback.
 */
export function useAgentDiscovery(options: UseAgentDiscoveryOptions = {}): UseAgentDiscoveryResult {
  const { enabled = true } = options;
  const [agents, setAgents] = useState<DiscoveredAgentInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const startDiscovery = useCallback(() => {
    if (!enabled) return;

    // Reset state
    setAgents([]);
    setIsLoading(true);
    setIsError(false);
    setError(null);
    setIsComplete(false);

    // Clean up any existing connection
    cleanup();

    // Create new EventSource connection
    const eventSource = new EventSource("/api/v1/config/setup/agents/stream");
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const agent: DiscoveredAgentInfo = JSON.parse(event.data);
        setAgents((prev) => {
          // Avoid duplicates
          if (prev.some((a) => a.name === agent.name)) {
            return prev;
          }
          return [...prev, agent];
        });
      } catch (err) {
        console.error("Failed to parse agent discovery event:", err);
      }
    };

    eventSource.onerror = (err) => {
      // EventSource automatically tries to reconnect on error
      // If readyState is CLOSED (2), the connection is done
      if (eventSource.readyState === EventSource.CLOSED) {
        setIsLoading(false);
        setIsComplete(true);
        cleanup();
      }
    };

    // Timeout to mark as complete after a reasonable time
    // The server closes the connection when all agents are probed,
    // but we add a client-side timeout as a safety net
    const timeoutId = setTimeout(() => {
      if (eventSourceRef.current) {
        setIsLoading(false);
        setIsComplete(true);
        cleanup();
      }
    }, 30000); // 30 second max timeout

    return () => {
      clearTimeout(timeoutId);
      cleanup();
    };
  }, [enabled, cleanup]);

  useEffect(() => {
    const cleanupFn = startDiscovery();
    return () => {
      cleanupFn?.();
      cleanup();
    };
  }, [startDiscovery, cleanup]);

  const retry = useCallback(() => {
    startDiscovery();
  }, [startDiscovery]);

  return {
    agents,
    isLoading,
    isError,
    error,
    isComplete,
    retry,
  };
}
