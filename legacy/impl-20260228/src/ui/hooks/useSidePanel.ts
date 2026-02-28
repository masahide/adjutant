import { useCallback, useState } from "react";

export type SidePanelTab = "heartbeat" | "audit";

export type SidePanelState = {
  open: boolean;
  activeTab: SidePanelTab;
  auditRunId: string | null;
};

export type SidePanelActions = {
  openHeartbeat: () => void;
  openAudit: (runId: string) => void;
  close: () => void;
  toggleHeartbeat: () => void;
  toggleAudit: (runId: string) => void;
  switchTab: (tab: SidePanelTab) => void;
  setAuditRunId: (runId: string) => void;
};

const INITIAL: SidePanelState = {
  open: false,
  activeTab: "heartbeat",
  auditRunId: null,
};

export function useSidePanel() {
  const [state, setState] = useState<SidePanelState>(INITIAL);

  const openHeartbeat = useCallback(() => {
    setState({ open: true, activeTab: "heartbeat", auditRunId: state.auditRunId });
  }, [state.auditRunId]);

  const openAudit = useCallback((runId: string) => {
    setState({ open: true, activeTab: "audit", auditRunId: runId });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const toggleHeartbeat = useCallback(() => {
    setState((prev) => {
      if (prev.open && prev.activeTab === "heartbeat") {
        return { ...prev, open: false };
      }
      return { ...prev, open: true, activeTab: "heartbeat" };
    });
  }, []);

  const toggleAudit = useCallback((runId: string) => {
    setState((prev) => {
      if (prev.open && prev.activeTab === "audit" && prev.auditRunId === runId) {
        return { ...prev, open: false };
      }
      return { open: true, activeTab: "audit", auditRunId: runId };
    });
  }, []);

  const switchTab = useCallback((tab: SidePanelTab) => {
    setState((prev) => ({ ...prev, activeTab: tab }));
  }, []);

  const setAuditRunId = useCallback((runId: string) => {
    setState((prev) => ({ ...prev, auditRunId: runId }));
  }, []);

  const actions: SidePanelActions = {
    openHeartbeat,
    openAudit,
    close,
    toggleHeartbeat,
    toggleAudit,
    switchTab,
    setAuditRunId,
  };

  return { state, actions };
}
