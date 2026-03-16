import { useAuiState } from "@assistant-ui/react";

type CurrentThreadListItemState = {
  id: string;
  remoteId?: string;
  title?: string;
  status: "new" | "regular" | "archived" | "deleted";
};

export function useCurrentThreadListItemState(): CurrentThreadListItemState {
  const id = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId
  );
  const title = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.title
  );
  const status = useAuiState(
    (s) =>
      s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.status ?? "regular"
  );

  return {
    id,
    remoteId,
    title,
    status,
  };
}
