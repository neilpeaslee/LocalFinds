// Pure helpers for logging WebFetch outcomes. No SDK/db imports (type-only) so
// this stays unit-testable in isolation, mirroring overpass.ts.
import type { FetchClass } from "@localfinds/db";

// The SDK flattens WebFetch results to text by the time we see them. Derive a
// coarse class from that text: blocked (401/403), error (other HTTP codes),
// truncated (size marker), or ok (got content).
export function classifyWebFetchResult(text: string): {
  klass: FetchClass;
  status: number | null;
} {
  const httpMatch = text.match(/HTTP (\d{3})/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 401 || status === 403) return { klass: "blocked", status };
    return { klass: "error", status };
  }
  if (text.includes("[Content truncated due to length")) {
    return { klass: "truncated", status: 200 };
  }
  return { klass: "ok", status: 200 };
}

// A tool_result's content may be a string or an array of text blocks.
export function webFetchResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
