import React from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="prose dark:prose-invert prose-sm max-w-none break-words"
      smooth
    />
  );
}
