import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import type { FC } from "react";

export const ThreadListSidebar: FC = () => {
  return (
    <aside className="adj-sidebar">
      <div className="adj-sidebar-header">
        <h2 className="adj-sidebar-title">Threads</h2>
        <ThreadListPrimitive.New asChild>
          <button type="button" className="adj-button adj-button-secondary">
            New
          </button>
        </ThreadListPrimitive.New>
      </div>

      <ThreadListPrimitive.Root className="adj-thread-list">
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
  return (
    <ThreadListItemPrimitive.Root className="adj-thread-item">
      <ThreadListItemPrimitive.Trigger asChild>
        <button type="button" className="adj-thread-trigger">
          <ThreadListItemPrimitive.Title fallback="Untitled" />
        </button>
      </ThreadListItemPrimitive.Trigger>
      <div className="adj-thread-actions">
        <ThreadListItemPrimitive.Archive asChild>
          <button type="button" className="adj-thread-action-button">
            Archive
          </button>
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete asChild>
          <button type="button" className="adj-thread-action-button">
            Delete
          </button>
        </ThreadListItemPrimitive.Delete>
      </div>
    </ThreadListItemPrimitive.Root>
  );
};
