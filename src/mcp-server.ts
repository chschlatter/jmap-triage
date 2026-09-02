// jmap-triage-mcp adapter: registers the 5 prompt-governance tools (see
// ARCHITECTURE.md) as MCP tools, and serves them over Streamable
// HTTP. Same seam as runPipeline (main.ts): current-prompt.ts,
// history.ts, report.ts, evaluate.ts and approve.ts are plain, deterministic
// TypeScript with no knowledge of MCP or any other caller; this file is a
// thin shell around them.
//
// Deployment shape: remote, publicly-reachable (Streamable HTTP), not local
// stdio -- the review session runs through Claude's hosted chat interface
// via a custom connector, same reason the existing Fastmail connector is
// remote. Runs as a plain Node http server; template.yaml fronts it with a
// Lambda Function URL (RESPONSE_STREAM) via the AWS Lambda Web Adapter,
// which just execs this file and proxies HTTP to whatever port it listens
// on -- no Lambda-specific glue code needed in here.
//
// Auth: Fastmail/Bedrock/Mistral credentials are read the same way every
// other module in this repo reads them (config.ts, process.env) -- this
// server runs with its own Lambda execution role and its own SSM
// parameters (see template.yaml), same SecureString pattern lambda.ts
// already uses. Auth for the transport itself is a single static bearer
// token (env var MCP_BEARER_TOKEN, or MCP_BEARER_TOKEN_PARAM for an
// SSM-backed value) -- the simplest fit for a single-user server.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { loadEnvFile } from "./config.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { getVersionHistory } from "./history.js";
import { getTriageReport } from "./report.js";
import { evaluateCandidate } from "./evaluate.js";
import { approvePromptDiff } from "./approve.js";

const SERVER_INFO = { name: "jmap-triage-mcp", version: "1.0.0" };

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// One McpServer + one tool registration pass, called fresh per HTTP request
// (see the stateless-mode handler below) -- cheap (five closures over
// already-imported pure functions), and it means a request can never see
// another request's in-flight state.
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "get_current_prompt",
    {
      title: "Get current prompt",
      description:
        "Returns current.json: {version, prompt} -- the live baseline every draft is built against. Always re-fetch at the start of each round; never assume an earlier round's version is still current.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await getCurrentPrompt());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_version_history",
    {
      title: "Get version history",
      description:
        "Returns past approved-version records, most recent first. This is the structured note-taking read path -- check whether a similar change was already tried and what happened when it was evaluated, before drafting a new diff.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
        sinceVersion: z.string().optional(),
      },
    },
    async ({ limit, sinceVersion }) => {
      try {
        return textResult(await getVersionHistory({ limit, sinceVersion }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_triage_report",
    {
      title: "Get triage report",
      description:
        "Queries every mailbox for $ai-* keywords, compares the stamped category to the email's current mailbox. Returns per-category mismatch ratios and the mismatch refs. notify is shown per-row, never folded into the ratios.",
      inputSchema: {
        since: z.string().optional(),
      },
    },
    async ({ since }) => {
      try {
        return textResult(await getTriageReport({ since }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "evaluate_candidate",
    {
      title: "Evaluate candidate prompt",
      description:
        "Static gate (version bump, JSON-reply shape intact, category vocabulary set-equal to the folder map -- always checked against the FULL vocabulary regardless of `category`), then, only if it passes, replay against corrections and a counterweight sample derived live from JMAP keyword state and prior approval history -- no stored corpus. Returns {gate, fixes, corrections, regressions} -- read-only, no writes. gate.candidateCategories echoes the category names parsed out of the candidate's CATEGORY section, regardless of pass/fail. corrections lists every open mismatch this call attempted to replay, each with status 'fixed' | 'unfixed' | 'error' -- fixes is just the 'fixed' subset, kept for convenience; check corrections when fixes comes back empty to see whether a message is still misclassifying (status 'unfixed', actualCategory shows what the model said instead) or the classify call itself failed (status 'error', see the error field) rather than assuming 'empty fixes' means nothing happened. regressions lists only counterweight rows that broke ('regressed') or errored ('error') -- a row that stayed correct isn't included. Pass `category` to scope the replay to just that one category (recommended when the diff only touches one category's wording -- the common case) for a faster, more thorough per-category check; omit it for a full sweep across all categories. Even scoped, this takes real time (Bedrock classification calls, not a lookup) -- treat anything under a few minutes as expected, not a hang.",
      inputSchema: {
        version: z.string(),
        prompt: z.string(),
        category: z.string().optional(),
      },
    },
    async ({ version, prompt, category }) => {
      try {
        return textResult(await evaluateCandidate({ version, prompt }, category));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "approve_prompt_diff",
    {
      title: "Approve prompt diff",
      description:
        "PERFORMS A LIVE WRITE. Writes current.json (the new live pointer) and an immutable history/<version>.json record. Only call this after the human reviewing this session has explicitly approved the candidate -- takes the evaluate_candidate result that justified the approval as input, not re-derived, so a record can't claim a replay outcome that didn't actually happen.",
      inputSchema: {
        candidate: z.object({ version: z.string(), prompt: z.string() }),
        evaluation: z.object({
          fixes: z.array(z.record(z.string(), z.unknown())),
          regressions: z.array(z.record(z.string(), z.unknown())),
        }),
        rationale: z.string(),
        evidence: z.array(z.string()),
        paragraphsEdited: z.array(z.string()),
      },
    },
    async ({ candidate, evaluation, rationale, evidence, paragraphsEdited }) => {
      try {
        return textResult(
          await approvePromptDiff(candidate, evaluation as any, { rationale, evidence, paragraphsEdited })
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

// --- Bearer-token auth for the transport itself ---
//
// OPEN BY DEFAULT (no MCP_BEARER_TOKEN/MCP_BEARER_TOKEN_PARAM configured):
// Claude.ai's custom-connector UI only reliably offers full OAuth 2.0 or no
// auth at all for an individual account -- the static-header option
// (`static_headers`, a fixed bearer token entered by an org admin) is beta
// and gated to Team/Enterprise workspaces, and a token embedded in the
// connector URL is explicitly discouraged (Claude's own connector-auth
// docs: URLs get logged in proxies/browser history). Given that, the
// deliberate choice here is to run without app-level auth for now, relying
// on the Function URL's own unguessable subdomain -- weak,
// not a real access control, but this is a single-user personal tool, not
// a shared service. The check below still activates automatically the
// moment either env var is set (e.g. after building real OAuth, or if
// static_headers becomes available), so re-enabling it needs no code
// change, just a redeploy.
let bearerTokenPromise: Promise<string> | undefined;

function bearerConfigured(): boolean {
  return !!(process.env.MCP_BEARER_TOKEN || process.env.MCP_BEARER_TOKEN_PARAM);
}

async function loadBearerToken(): Promise<string> {
  const inline = process.env.MCP_BEARER_TOKEN;
  if (inline) return inline;

  const paramName = process.env.MCP_BEARER_TOKEN_PARAM;
  if (!paramName) {
    throw new Error("Neither MCP_BEARER_TOKEN nor MCP_BEARER_TOKEN_PARAM is set");
  }
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${paramName} returned no value`);
  return value;
}

async function isAuthorized(req: IncomingMessage): Promise<boolean> {
  if (!bearerConfigured()) return true;

  bearerTokenPromise ??= loadBearerToken();
  const expected = await bearerTokenPromise.catch((err) => {
    bearerTokenPromise = undefined;
    throw err;
  });
  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] === expected;
}

// --- Fastmail token: fetched from SSM at first use, same cold-start-cache
// pattern lambda.ts uses for TriageFunction's secrets, then exposed to
// report.ts/evaluate.ts the same way they already read it everywhere else
// (config.ts's requireFastmailToken(), process.env.FASTMAIL_TOKEN) -- so
// those modules stay unaware this server fetches it any differently than
// the CLI/eval path does.

let fastmailTokenPromise: Promise<void> | undefined;

async function ensureFastmailToken(): Promise<void> {
  if (process.env.FASTMAIL_TOKEN) return; // already set, e.g. local dev via .env
  fastmailTokenPromise ??= (async () => {
    const paramName = process.env.FASTMAIL_TOKEN_PARAM;
    if (!paramName) return; // not configured; requireFastmailToken() will raise its own clear error
    const ssm = new SSMClient({});
    const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (value) process.env.FASTMAIL_TOKEN = value;
  })();
  await fastmailTokenPromise;
}

// Same pattern as ensureFastmailToken() above, for evaluate.ts's
// requireModelConfig() call (used by evaluate_candidate). Only meaningful
// when MODEL_PROVIDER=mistral -- in Bedrock mode MISTRAL_API_KEY_PARAM is
// simply never set, so this is a silent no-op and evaluate.ts never asks
// for the value it would have populated.
let mistralApiKeyPromise: Promise<void> | undefined;

async function ensureMistralApiKey(): Promise<void> {
  if (process.env.MISTRAL_API_KEY) return; // already set, e.g. local dev via .env
  mistralApiKeyPromise ??= (async () => {
    const paramName = process.env.MISTRAL_API_KEY_PARAM;
    if (!paramName) return; // not configured -- MODEL_PROVIDER isn't "mistral"
    const ssm = new SSMClient({});
    const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (value) process.env.MISTRAL_API_KEY = value;
  })();
  await mistralApiKeyPromise;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

// Stateless mode: a fresh McpServer + transport per request, no session id,
// no resumability -- the right fit for a server that can be freely
// recycled between invocations rather than holding long-lived in-memory
// session state, per the SDK's own stateless-mode guidance.
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  try {
    if (!(await isAuthorized(req))) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  } catch (err) {
    res
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: `auth check failed: ${err instanceof Error ? err.message : err}` }));
    return;
  }

  try {
    await ensureFastmailToken();
    await ensureMistralApiKey();
  } catch (err) {
    res
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: `failed to load secrets: ${err instanceof Error ? err.message : err}` }));
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function startHttpServer(port: number): void {
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      // Lambda Web Adapter health check target.
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/mcp") {
      handleMcpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  httpServer.listen(port, () => {
    console.log(`jmap-triage-mcp listening on :${port}`);
  });
}

// Always the entrypoint in practice (local `npx tsx src/mcp-server.ts`, or
// `node mcp-server.js` execed by run.sh under the Lambda Web Adapter -- see
// run.sh/template.yaml) -- there's no other module that imports this file,
// so an isMain guard would just be dead weight. No top-level await, though:
// run.sh's `node mcp-server.js` runs the CJS bundle directly, and CJS
// output can't have top-level await (esbuild rejects it), so this is
// wrapped in an IIFE instead.
(async () => {
  // Harmless no-op in Lambda (no .env file is packaged, and this never
  // overwrites an already-set env var) -- same as eval/run-eval.ts calling
  // it unconditionally regardless of environment.
  await loadEnvFile();
  const port = Number(process.env.PORT ?? 8080);
  startHttpServer(port);
})();
