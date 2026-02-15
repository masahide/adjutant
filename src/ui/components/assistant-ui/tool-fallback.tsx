import React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

export function ToolFallback({ toolName, argsText }: ToolCallMessagePartProps) {
  return (
    <div className="my-2 rounded-lg border bg-muted/50 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Tool call: {toolName}</span>
      </div>
      {argsText && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-muted-foreground">
          {argsText}
        </pre>
      )}
    </div>
  );
}
