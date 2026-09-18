import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ApprovalAuthority } from "./approval-authority.js";
import { DesignTraceError } from "../core/errors.js";

interface OperatorSession {
  csrfToken: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new DesignTraceError("INVALID_PROJECT", "Operator request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class OperatorServer {
  readonly #sessions = new Map<string, OperatorSession>();
  #server: Server | null = null;
  #origin: string | null = null;

  constructor(private readonly authority: ApprovalAuthority) {}

  async start(): Promise<string> {
    if (this.#server || this.#origin) throw new Error("Operator server is already running");
    this.#server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => this.sendError(response, error));
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Operator server did not bind a TCP port");
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => {
      this.#server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.#server = null;
    this.#origin = null;
    this.#sessions.clear();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#origin) throw new Error("Operator server is not ready");
    const host = request.headers.host;
    if (host !== this.#origin.slice("http://".length)) {
      this.respond(response, 400, "Invalid Host header", "text/plain; charset=utf-8");
      return;
    }
    const url = new URL(request.url ?? "/", this.#origin);
    const match = /^\/review\/(execution|result)\/(REV-[A-F0-9]{20})$/u.exec(url.pathname);
    if (!match?.[1] || !match[2]) {
      this.respond(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    const stage = match[1] as "execution" | "result";
    const reviewId = match[2];

    if (request.method === "GET") {
      const review = await this.authority.getOperatorReview(reviewId);
      if (review.stage !== stage) {
        this.respond(response, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
      if (review.consumed_at) {
        this.respond(response, 409, "This review has already been used.", "text/plain; charset=utf-8");
        return;
      }
      const sessionId = randomBytes(32).toString("hex");
      const csrfToken = randomBytes(32).toString("hex");
      this.#sessions.set(sessionId, { csrfToken });
      response.setHeader("Set-Cookie", `dt_operator_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
      const details = review.stage === "execution"
        ? `<h2>Request</h2><p>${escapeHtml(review.request)}</p><h2>Goal</h2><p>${escapeHtml(review.goal)}</p>` +
          `<p>Risk: ${escapeHtml(review.risk_level)}</p><h2>Allowed paths</h2><ul>${review.allowed_paths
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul><h2>Protected checks</h2><ul>${review.protected_checks
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul><h2>Impacts</h2><p>Definite: ${escapeHtml(review.impacts.definite.join(", ") || "none")}</p>` +
          `<p>Possible: ${escapeHtml(review.impacts.possible.join(", ") || "none")}</p>`
        : `<h2>Bundle</h2><p>${escapeHtml(review.bundle_id)}</p>` +
          `<p>Payload tree: ${escapeHtml(review.payload_tree_oid)}</p>` +
          `<p>Validation: ${escapeHtml(review.validation_batch_id)}</p>` +
          `<h2>Changed paths</h2><ul>${review.changed_paths.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      this.respond(
        response,
        200,
        `<!doctype html><html><body><h1>Approve ${stage === "execution" ? "execution plan" : "result bundle"}</h1>` +
          details + `<form method="post">` +
          `<input type="hidden" name="csrf_token" value="${csrfToken}">` +
          `<input type="hidden" name="nonce" value="${review.nonce}">` +
          `<button type="submit" name="action" value="approve">Approve</button>` +
          `<button type="submit" name="action" value="reject">Reject and cancel</button></form></body></html>`,
        "text/html; charset=utf-8",
      );
      return;
    }

    if (request.method === "POST") {
      if (request.headers.origin !== this.#origin) {
        this.respond(response, 403, "Origin check failed", "text/plain; charset=utf-8");
        return;
      }
      const cookie = request.headers.cookie ?? "";
      const sessionId = /(?:^|;\s*)dt_operator_session=([a-f0-9]{64})(?:;|$)/u.exec(cookie)?.[1];
      const operatorSession = sessionId ? this.#sessions.get(sessionId) : undefined;
      if (!sessionId || !operatorSession) {
        this.respond(response, 403, "Operator session is missing", "text/plain; charset=utf-8");
        return;
      }
      const body = new URLSearchParams(await requestBody(request));
      if (body.get("csrf_token") !== operatorSession.csrfToken) {
        this.respond(response, 403, "CSRF check failed", "text/plain; charset=utf-8");
        return;
      }
      const nonce = body.get("nonce") ?? "";
      if (body.get("action") === "reject") {
        await this.authority.rejectReview(reviewId, nonce);
      } else if (stage === "execution") {
        await this.authority.approveExecution(reviewId, nonce, sessionId);
      } else {
        await this.authority.approveResult(reviewId, nonce, sessionId);
      }
      this.#sessions.delete(sessionId);
      this.respond(
        response,
        200,
        body.get("action") === "reject"
          ? "Review rejected and Change cancelled."
          : stage === "execution" ? "Execution plan approved." : "Result bundle approved.",
        "text/plain; charset=utf-8",
      );
      return;
    }

    response.setHeader("Allow", "GET, POST");
    this.respond(response, 405, "Method not allowed", "text/plain; charset=utf-8");
  }

  private respond(response: ServerResponse, status: number, body: string, contentType: string): void {
    response.writeHead(status, {
      "Content-Type": contentType,
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  private sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    const status = error instanceof DesignTraceError ? 409 : 500;
    this.respond(response, status, error instanceof Error ? error.message : String(error), "text/plain; charset=utf-8");
  }
}
