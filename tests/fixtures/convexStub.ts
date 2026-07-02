import { createServer, type Server } from "node:http";

/**
 * Minimal in-process stand-in for a Convex deployment, speaking the exact
 * wire protocol ConvexHttpClient uses (POST /api/query|mutation|action with
 * {path, format, args:[...]}, responding {status:"success"|"error", ...}).
 * Lets route handlers under test run unmodified: point
 * NEXT_PUBLIC_CONVEX_URL at the stub and script the function results.
 */

export type ConvexCall = {
  kind: "query" | "mutation" | "action";
  path: string;
  args: Record<string, unknown>;
};

export type ConvexResult =
  | { value: unknown }
  | { errorMessage: string; errorData?: unknown };

export type ConvexStub = {
  url: string;
  calls: ConvexCall[];
  close: () => Promise<void>;
};

export function startConvexStub(
  handle: (call: ConvexCall) => ConvexResult,
): Promise<ConvexStub> {
  const calls: ConvexCall[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const kind = request.url?.replace("/api/", "") as ConvexCall["kind"];
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const call: ConvexCall = {
        kind,
        path: body.path,
        args: (body.args?.[0] ?? {}) as Record<string, unknown>,
      };
      calls.push(call);
      const result = handle(call);
      const payload =
        "value" in result
          ? { status: "success", value: result.value, logLines: [] }
          : {
              status: "error",
              errorMessage: result.errorMessage,
              errorData: result.errorData,
              logLines: [],
            };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
