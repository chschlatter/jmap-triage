// jmap-triage-mcp: registers the 5 prompt-governance tools (ARCHITECTURE.md)
// and serves them over Streamable HTTP. Same seam as runPipeline (main.ts) --
// current-prompt.ts, history.ts, report.ts, evaluate.ts and approve.ts are
// plain TypeScript with no knowledge of MCP; this file is a thin shell.
//
// Remote and publicly reachable rather than local stdio, because the review
// session runs through Claude's hosted chat interface via a custom connector.
// A plain Node http server: the Lambda Web Adapter execs this file and
// proxies HTTP to its port, so there is no Lambda-specific code here.

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

// Called fresh per HTTP request (stateless mode, below) -- cheap, five
// closures over already-imported pure functions, and no request can see
// another's in-flight state.
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
        "Read-only. Static gate (version bump, JSON-reply shape intact, category vocabulary set-equal to the folder map -- always the FULL vocabulary, regardless of `category`), then, only if it passes, a replay against open corrections and a counterweight sample derived live from JMAP keyword state and prior approvals. No stored corpus. Returns {gate, fixes, corrections, regressions}. gate.candidateCategories echoes what was parsed out of the candidate's CATEGORY section, pass or fail. corrections lists every open mismatch replayed, with status 'fixed' | 'unfixed' | 'error'; fixes is just the 'fixed' subset. When fixes is empty, read corrections rather than assuming nothing happened -- 'unfixed' means still misclassifying (actualCategory shows what the model said), 'error' means the classify call itself failed. regressions lists only counterweight rows that broke or errored. Pass `category` to scope the replay to one category -- recommended when the diff touches only that category's wording, the common case -- or omit it for a full sweep. Either way this makes real classification calls, so a few minutes is expected, not a hang.",
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

// --- Bearer-token auth for the transport ---
//
// OPEN BY DEFAULT: with neither MCP_BEARER_TOKEN nor MCP_BEARER_TOKEN_PARAM
// set, every request is authorized. That is deliberate -- see README.md's
// "Auth is off by deliberate choice" for why, and what it costs. The check
// activates the moment either var is set, so re-enabling is a redeploy, not
// a code change.
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

// Secrets: same cold-start cache as lambda.ts, but exposed through
// process.env, the way config.ts's require* already reads them everywhere --
// so those modules stay unaware this server fetches them at all.
//
// Populates process.env[envVar] from the SSM SecureString named by
// process.env[paramEnvVar], once per container. Both credentials the tools
// need load this way, hence one helper rather than one per secret. A missing
// *_PARAM is a silent no-op: config.ts raises a clear error if the value is
// actually needed, and local dev sets these via .env.
const ssmLoads = new Map<string, Promise<void>>();

function ensureEnvFromSsm(envVar: string, paramEnvVar: string): Promise<void> {
  if (process.env[envVar]) return Promise.resolve();
  let load = ssmLoads.get(envVar);
  if (!load) {
    load = (async () => {
      const paramName = process.env[paramEnvVar];
      if (!paramName) return;
      const ssm = new SSMClient({});
      const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
      const value = res.Parameter?.Value;
      if (value) process.env[envVar] = value;
    })();
    ssmLoads.set(envVar, load);
  }
  return load;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

// Stateless mode per the SDK's guidance: fresh McpServer + transport per
// request, no session id, no resumability -- the right fit for a server
// freely recycled between invocations.
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
    await ensureEnvFromSsm("FASTMAIL_TOKEN", "FASTMAIL_TOKEN_PARAM");
    await ensureEnvFromSsm("GREENPT_API_KEY", "GREENPT_API_KEY_PARAM");
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

// Nothing imports this file, so an isMain guard would be dead weight. The
// IIFE is not: run.sh runs the CJS bundle directly, and esbuild rejects
// top-level await in CJS output.
(async () => {
  // No-op in Lambda -- no .env is packaged, and this never overwrites an
  // already-set env var.
  await loadEnvFile();
  const port = Number(process.env.PORT ?? 8080);
  startHttpServer(port);
})();
