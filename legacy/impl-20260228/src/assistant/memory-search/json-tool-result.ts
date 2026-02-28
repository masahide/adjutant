export function jsonToolResult<T>(payload: T): {
  content: Array<{ type: "text"; text: string }>;
  details: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
