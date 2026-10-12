import type { IncomingMessage, ServerResponse } from "node:http";
import type { createHandler } from "../server/app.js";

// Reuse the existing HTTP route handler without opening a Node server in Workers.
export async function handleFetch(
  request: Request,
  handler: ReturnType<typeof createHandler>,
) {
  const url = new URL(request.url);
  const req = {
    url: url.pathname + url.search,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    socket: {
      remoteAddress: request.headers.get("x-unity-client-ip") || "unknown",
    },
    async *[Symbol.asyncIterator]() {
      const reader = request.body?.getReader();
      if (!reader) return;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  } as unknown as IncomingMessage;
  const headers = new Headers();
  let status = 200;
  let result: Response | undefined;
  const res = {
    setHeader(name: string, value: string | number) {
      headers.set(name, String(value));
      return res;
    },
    writeHead(code: number, values?: Record<string, string>) {
      status = code;
      for (const [name, value] of Object.entries(values || {}))
        headers.set(name, value);
      return res;
    },
    end(value?: string | Uint8Array) {
      result = new Response(value === undefined ? null : (value as BodyInit), {
        status,
        headers,
      });
      return res;
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  if (!result) throw new Error("HTTP handler did not finish the response");
  return result;
}
