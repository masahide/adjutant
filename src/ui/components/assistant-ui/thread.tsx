import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type { FC } from "react";

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root className="adj-thread">
      <ThreadPrimitive.Viewport className="adj-thread-viewport" turnAnchor="top">
        <ThreadPrimitive.Empty>
          <div className="adj-empty">メッセージを送信すると会話が始まります。</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
        <ThreadPrimitive.ViewportFooter className="adj-thread-footer">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="adj-composer">
      <ComposerPrimitive.Input
        className="adj-composer-input"
        placeholder="メッセージを入力..."
        rows={1}
      />
      <div className="adj-composer-actions">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <button type="button" className="adj-button adj-button-primary">
              Send
            </button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="adj-button adj-button-secondary">
              Cancel
            </button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="adj-message adj-message-user">
      <MessagePrimitive.Content />
    </MessagePrimitive.Root>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="adj-message adj-message-assistant">
      <MessagePrimitive.Content />
      <MessagePrimitive.Error>
        <div className="adj-message-error">応答の生成中にエラーが発生しました。</div>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
};
