// The shared MCP tool-result contract: text content, optionally flagged as a
// failed call. A type alias (not an interface) so it keeps the implicit index
// signature the Agent SDK's tool-handler return type requires. Its own module
// so tool helpers (ical.ts, and any future tool) share it without importing
// from an unrelated client.
export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};
