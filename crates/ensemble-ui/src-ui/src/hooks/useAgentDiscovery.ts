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
  const eventSourceRef = useRef<EventSource | null>(null);
  const consecutiveErrorsRef = useRef(0);

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
    consecutiveErrorsRef.current = 0;

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
        // Reset error count on successful message
        consecutiveErrorsRef.current = 0;
      } catch (err) {
        console.error("Failed to parse agent discovery event:", err);
      }
    };

    eventSource.onerror = () => {
      // EventSource automatically tries to reconnect on error
      // Track consecutive errors to detect real failures vs temporary issues
      consecutiveErrorsRef.current += 1;

      if (consecutiveErrorsRef.current >= 3) {
        // After 3 consecutive errors, consider it a failure
        setIsError(true);
        setError(new Error("Failed to connect to agent discovery stream"));
        setIsLoading(false);
        cleanup();
      } else if (eventSource.readyState === EventSource.CLOSED) {
        // Connection closed permanently
        setIsLoading(false);
        cleanup();
      }
    };

    // Handle connection open
    eventSource.onopen = () => {
      // Reset error count on successful connection
      consecutiveErrorsRef.current = 0;
    };
  }, [enabled, cleanup]);

  useEffect(() => {
    const cleanupFn = startDiscovery();
    return () => {
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
    retry,
  };
}
