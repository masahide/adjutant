import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  MessageSquareIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type { FC } from "react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

export const ThreadListSidebar: FC = () => {
  return (
    <aside className="flex flex-col border-r border-border/40 bg-[#0a0e14]">
      <div className="flex flex-col gap-3 p-3 pb-2">
        <div className="px-1 text-lg font-bold tracking-tight text-foreground/90">
          Adjutant
        </div>
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

      <ThreadListPrimitive.Root className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <ThreadListPrimitive.Items
          components={{
            ThreadListItem,
          }}
        />
      </ThreadListPrimitive.Root>
    </aside>
  );
};

const ThreadListItem: FC = () => {
  const aui = useAui();
  let isDefaultThread = false;
  try {
    const state = aui.threadListItem().getState() as { id?: string; remoteId?: string };
    isDefaultThread = state.remoteId === "main" || state.id === "main";
  } catch {
    isDefaultThread = false;
  }

  return (
    <ThreadListItemPrimitive.Root className="group relative flex items-center rounded-lg text-sm transition-colors hover:bg-accent/40 data-[active]:bg-accent/60">
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
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active]:opacity-100">
        <ThreadListItemPrimitive.Archive asChild>
          <TooltipIconButton tooltip="Archive" side="bottom" className="size-6">
            <ArchiveIcon className="size-3.5" />
          </TooltipIconButton>
        </ThreadListItemPrimitive.Archive>
        {isDefaultThread ? null : (
          <ThreadListItemPrimitive.Delete asChild>
            <TooltipIconButton
              tooltip="Delete"
              side="bottom"
              className="size-6 text-destructive/70 hover:text-destructive"
            >
              <Trash2Icon className="size-3.5" />
            </TooltipIconButton>
          </ThreadListItemPrimitive.Delete>
        )}
      </div>
    </ThreadListItemPrimitive.Root>
  );
};
