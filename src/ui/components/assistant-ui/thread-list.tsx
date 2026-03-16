import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { createContext, type FC, use, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useCurrentThreadListItemState } from "@/lib/use-current-thread-list-item";

type ArchivedThreadToastState = {
  id: string;
  title: string;
};

type ThreadListActionsContextValue = {
  onArchived: (thread: ArchivedThreadToastState) => void;
  onUnarchived: (threadId: string) => void;
};

const ThreadListActionsContext = createContext<ThreadListActionsContextValue | null>(null);

const ARCHIVE_TOAST_DURATION_MS = 8_000;

export const ThreadListSidebar: FC = () => {
  const aui = useAui();
  const archivedCount = useAuiState((s) => s.threads.archivedThreadIds.length);
  const currentThreadListItem = useCurrentThreadListItemState();
  const selectedThreadStatus = currentThreadListItem.status;
  const selectedThreadId = currentThreadListItem.remoteId || currentThreadListItem.id;
  const selectedThreadTitle = currentThreadListItem.title;
  const selectedThreadIsRunning = useAuiState((s) => s.thread.isRunning);
  const selectedThreadUserMessageCount = useAuiState(
    (s) => s.thread.messages.filter((message) => message.role === "user").length
  );
  const [isArchivedOpen, setIsArchivedOpen] = useState(false);
  const [archivedToast, setArchivedToast] = useState<ArchivedThreadToastState | null>(null);
  const archiveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoGeneratingThreadIdsRef = useRef(new Set<string>());

  const handleArchived = useCallback((thread: ArchivedThreadToastState) => {
    setArchivedToast(thread);
    setIsArchivedOpen(true);
  }, []);

  const handleUnarchived = useCallback((threadId: string) => {
    setArchivedToast((current) => (current?.id === threadId ? null : current));
  }, []);

  const handleUndoArchive = useCallback(async () => {
    if (archivedToast === null) {
      return;
    }
    try {
      await aui.threads().item({ id: archivedToast.id }).unarchive();
    } finally {
      setArchivedToast(null);
    }
  }, [archivedToast, aui]);

  useEffect(() => {
    if (selectedThreadStatus === "archived") {
      setIsArchivedOpen(true);
    }
  }, [selectedThreadStatus]);

  useEffect(() => {
    const threadId = selectedThreadId?.trim() ?? "";
    const title = selectedThreadTitle?.trim() ?? "";
    if (threadId.length > 0 && title.length > 0) {
      autoGeneratingThreadIdsRef.current.delete(threadId);
    }
    const shouldGenerate =
      threadId.length > 0 &&
      threadId !== "main" &&
      selectedThreadStatus === "regular" &&
      title.length === 0 &&
      !selectedThreadIsRunning &&
      selectedThreadUserMessageCount > 0;
    if (!shouldGenerate) {
      return;
    }
    if (autoGeneratingThreadIdsRef.current.has(threadId)) {
      return;
    }
    autoGeneratingThreadIdsRef.current.add(threadId);
    try {
      aui.threadListItem().generateTitle();
    } catch {
      autoGeneratingThreadIdsRef.current.delete(threadId);
      return;
    }
    const timeoutId = setTimeout(() => {
      autoGeneratingThreadIdsRef.current.delete(threadId);
    }, 5_000);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [
    aui,
    selectedThreadId,
    selectedThreadIsRunning,
    selectedThreadStatus,
    selectedThreadTitle,
    selectedThreadUserMessageCount,
  ]);

  useEffect(() => {
    if (archivedToast === null) {
      if (archiveToastTimerRef.current !== null) {
        clearTimeout(archiveToastTimerRef.current);
        archiveToastTimerRef.current = null;
      }
      return;
    }

    archiveToastTimerRef.current = setTimeout(() => {
      setArchivedToast(null);
      archiveToastTimerRef.current = null;
    }, ARCHIVE_TOAST_DURATION_MS);

    return () => {
      if (archiveToastTimerRef.current !== null) {
        clearTimeout(archiveToastTimerRef.current);
        archiveToastTimerRef.current = null;
      }
    };
  }, [archivedToast]);

  return (
    <ThreadListActionsContext
      value={{ onArchived: handleArchived, onUnarchived: handleUnarchived }}
    >
      <aside className="adj-sidebar relative flex flex-col border-r border-border/40">
        <div className="flex flex-col gap-3 p-3 pb-2">
          <div className="px-1 text-lg font-bold tracking-tight text-foreground/90">Adjutant</div>
          <ThreadListPrimitive.Root className="flex flex-col gap-0.5">
            <ThreadListPrimitive.Items components={PINNED_MAIN_THREAD_COMPONENTS} />
          </ThreadListPrimitive.Root>
          <ThreadListPrimitive.New asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-border/30 bg-background/40 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent/40"
            >
              <PlusIcon className="size-4" />
              <span>New Thread</span>
            </button>
          </ThreadListPrimitive.New>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
          <ThreadListPrimitive.Root className="flex flex-col gap-0.5">
            <ThreadListPrimitive.Items components={REGULAR_THREAD_LIST_ITEM_COMPONENTS} />
          </ThreadListPrimitive.Root>

          {archivedCount > 0 ? (
            <Collapsible open={isArchivedOpen} onOpenChange={setIsArchivedOpen} className="mt-4">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:bg-accent/30 hover:text-foreground/75"
                >
                  <span>アーカイブ済み</span>
                  <span className="flex items-center gap-2 text-[11px] font-medium tracking-normal normal-case">
                    <span>{archivedCount}</span>
                    <ChevronDownIcon
                      className={`size-3.5 transition-transform ${isArchivedOpen ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 flex flex-col gap-0.5">
                <ThreadListPrimitive.Root className="flex flex-col gap-0.5">
                  <ThreadListPrimitive.Items
                    archived
                    components={{
                      ThreadListItem,
                    }}
                  />
                </ThreadListPrimitive.Root>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>

        {archivedToast ? (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10">
            <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/95 px-3 py-2 shadow-lg backdrop-blur">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground/88">
                  スレッドをアーカイブしました
                </div>
                <div className="truncate text-xs text-muted-foreground">{archivedToast.title}</div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="shrink-0"
                onClick={() => {
                  void handleUndoArchive();
                }}
              >
                元に戻す
              </Button>
            </div>
          </div>
        ) : null}
      </aside>
    </ThreadListActionsContext>
  );
};

const ThreadListItemBase = () => {
  const aui = useAui();
  const threadListActions = use(ThreadListActionsContext);
  const threadRemoteId = useAuiState((s) => s.threadListItem.remoteId);
  const threadLocalId = useAuiState((s) => s.threadListItem.id);
  const threadStatus = useAuiState((s) => s.threadListItem.status);
  const threadTitle = useAuiState((s) => s.threadListItem.title);
  const isMainThread = isMainThreadItem(threadRemoteId, threadLocalId);
  const threadId = threadRemoteId || threadLocalId || "main";
  const isArchived = threadStatus === "archived";
  const title = resolveThreadTitle(threadTitle, isMainThread);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(title);
    }
  }, [isEditing, title]);

  const handleArchive = useCallback(async () => {
    const latestItem = readThreadListItemIdentity(aui);
    const latestThreadId = latestItem.remoteId || latestItem.id || "main";
    if (latestThreadId === "main" || isArchived) {
      return;
    }
    await aui.threadListItem().archive();
    threadListActions?.onArchived({
      id: latestThreadId,
      title,
    });
  }, [aui, isArchived, isMainThread, threadId, threadListActions, title]);

  const handleUnarchive = useCallback(async () => {
    if (!isArchived) {
      return;
    }
    await aui.threadListItem().unarchive();
    threadListActions?.onUnarchived(threadId);
  }, [aui, isArchived, threadId, threadListActions]);

  const openEdit = useCallback(() => {
    setDraftTitle(title);
    setIsEditing(true);
  }, [title]);

  const cancelEdit = useCallback(() => {
    setDraftTitle(title);
    setIsEditing(false);
  }, [title]);

  const submitEdit = useCallback(async () => {
    const nextTitle = draftTitle.trim();
    if (nextTitle.length === 0 || nextTitle === title) {
      setDraftTitle(title);
      setIsEditing(false);
      return;
    }
    await aui.threadListItem().rename(nextTitle);
    setIsEditing(false);
  }, [aui, draftTitle, title]);

  const actionButtons = (() => {
    if (isEditing) {
      return (
        <>
          <TooltipIconButton
            tooltip="保存"
            side="bottom"
            className="size-6"
            onClick={() => {
              void submitEdit();
            }}
          >
            <CheckIcon className="size-3.5" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="キャンセル"
            side="bottom"
            className="size-6"
            onClick={cancelEdit}
          >
            <XIcon className="size-3.5" />
          </TooltipIconButton>
        </>
      );
    }

    return (
      <>
        {isMainThread ? null : (
          <TooltipIconButton
            tooltip="タイトルを編集"
            side="bottom"
            className="size-6"
            onClick={openEdit}
          >
            <PencilIcon className="size-3.5" />
          </TooltipIconButton>
        )}
        {isArchived ? (
          <TooltipIconButton
            tooltip="復元"
            side="bottom"
            className="size-6"
            onClick={() => {
              void handleUnarchive();
            }}
          >
            <RotateCcwIcon className="size-3.5" />
          </TooltipIconButton>
        ) : isMainThread ? null : (
          <TooltipIconButton
            tooltip="アーカイブ"
            side="bottom"
            className="size-6"
            onClick={() => {
              void handleArchive();
            }}
          >
            <ArchiveIcon className="size-3.5" />
          </TooltipIconButton>
        )}
      </>
    );
  })();

  return (
    <ThreadListItemPrimitive.Root
      className={`group relative flex items-center rounded-lg text-sm transition-colors hover:bg-accent/40 data-[active]:bg-accent/60 ${isArchived ? "opacity-80" : ""}`}
    >
      {isEditing ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2">
          <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={draftTitle}
            autoFocus
            className="min-w-0 flex-1 rounded bg-background/70 px-2 py-1 text-sm text-foreground outline-none ring-1 ring-border/60 focus:ring-2 focus:ring-ring/40"
            onChange={(event) => {
              setDraftTitle(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitEdit();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={() => {
              void submitEdit();
            }}
          />
        </div>
      ) : isArchived ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
          <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground/70" />
          <span className="truncate text-foreground/65">
            <ThreadListItemPrimitive.Title fallback="Untitled" />
          </span>
        </div>
      ) : (
        <ThreadListItemPrimitive.Trigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
          >
            <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground/85">
              <ThreadListItemPrimitive.Title fallback="Untitled" />
            </span>
          </button>
        </ThreadListItemPrimitive.Trigger>
      )}
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active]:opacity-100">
        {actionButtons}
      </div>
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItem = () => {
  return <ThreadListItemBase />;
};

const MainOnlyThreadListItem = () => {
  const threadRemoteId = useAuiState((s) => s.threadListItem.remoteId);
  const threadLocalId = useAuiState((s) => s.threadListItem.id);
  const isMainThread = isMainThreadItem(threadRemoteId, threadLocalId);
  if (!isMainThread) {
    return null;
  }
  return <ThreadListItemBase />;
};

const NonMainThreadListItem = () => {
  const threadRemoteId = useAuiState((s) => s.threadListItem.remoteId);
  const threadLocalId = useAuiState((s) => s.threadListItem.id);
  const isMainThread = isMainThreadItem(threadRemoteId, threadLocalId);
  if (isMainThread) {
    return null;
  }
  return <ThreadListItemBase />;
};

function resolveThreadTitle(title: string | undefined, isMain: boolean): string {
  const trimmed = title?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return isMain ? "Main" : "Untitled";
}

function isMainThreadItem(remoteId: string | undefined, localId: string | undefined): boolean {
  return remoteId === "main" || (remoteId === undefined && localId === "main");
}

const THREAD_LIST_ITEM_COMPONENTS = {
  ThreadListItem,
} as const;

const PINNED_MAIN_THREAD_COMPONENTS = {
  ThreadListItem: MainOnlyThreadListItem,
} as const;

const REGULAR_THREAD_LIST_ITEM_COMPONENTS = {
  ThreadListItem: NonMainThreadListItem,
} as const;

function readThreadListItemIdentity(aui: ReturnType<typeof useAui>): {
  id?: string;
  remoteId?: string;
} {
  try {
    const state = aui.threadListItem().getState() as {
      id?: string;
      remoteId?: string;
    };
    return {
      id: state.id,
      remoteId: state.remoteId,
    };
  } catch {
    return {};
  }
}
