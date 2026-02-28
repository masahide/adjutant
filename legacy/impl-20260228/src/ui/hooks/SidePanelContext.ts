import { createContext, useContext } from "react";
import type { SidePanelActions } from "./useSidePanel.js";

const noop = () => {};
const noopStr = (_s: string) => {};

export const SidePanelContext = createContext<SidePanelActions>({
  openHeartbeat: noop,
  openAudit: noopStr,
  close: noop,
  toggleHeartbeat: noop,
  toggleAudit: noopStr,
  switchTab: noop,
  setAuditRunId: noopStr,
});

export function useSidePanelActions(): SidePanelActions {
  return useContext(SidePanelContext);
}
