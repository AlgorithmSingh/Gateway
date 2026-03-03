import { createServer } from "node:http";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { SessionStore } from "./sessions.js";
import { VertexLlmClient } from "./llm.js";
import { createTools, initializeAgentSandbox } from "./tools.js";
import { runAgent } from "./agent.js";

type GatewayRequest =
  | { method: "chat"; message: string; sessionId?: string }
  | { method: "sessions_list" }
  | { method: "session_switch"; sessionId: string }
  | { method: "session_clear"; sessionId?: string }
  | { method: "session_create" }
  | { method: "refresh" };

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function parseRequest(raw: unknown): GatewayRequest {
  if (typeof raw !== "string") {
    throw new Error("Invalid request payload");
  }
  const parsed = JSON.parse(raw) as Partial<GatewayRequest>;
  if (!parsed.method || typeof parsed.method !== "string") {
    throw new Error("Missing method");
  }
  return parsed as GatewayRequest;
}

async function runGateway(): Promise<void> {
  const configPath = process.env.FINOPS_CONFIG;
  const config = loadConfig(configPath);
  await initializeAgentSandbox({ workspaceDir: config.workspaceDir });

  const sessionStore = new SessionStore(config.sessionDir);
  await sessionStore.init();

  const llm = new VertexLlmClient(config);
  const tools = createTools({
    workspaceDir: config.workspaceDir,
    skillsDir: config.skillsDir,
    gcpProject: config.gcpProject,
  });

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "finops-gateway",
        wsPath: "/ws",
      }),
    );
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws) => {
    let activeSessionId: string | undefined;
    let queue: Promise<void> = Promise.resolve();
    let currentAgentAbort: AbortController | null = null;
    // Monotonic counter: incremented on every session change.
    // Agent events are suppressed when the run's generation doesn't match,
    // preventing stale tool_result / text events from restarting the spinner
    // after the user switches sessions.
    let generation = 0;

    const sendSessions = async () => {
      const sessions = await sessionStore.listSessions();
      send(ws, {
        type: "sessions",
        sessions,
        activeSessionId,
      });
    };

    const ensureSession = async (requestedId?: string) => {
      if (requestedId) {
        const existing = await sessionStore.getSession(requestedId);
        if (existing) {
          activeSessionId = existing.id;
          return existing;
        }
      }
      if (activeSessionId) {
        const active = await sessionStore.getSession(activeSessionId);
        if (active) {
          return active;
        }
      }
      const sessions = await sessionStore.listSessions();
      if (sessions.length > 0) {
        const latest = await sessionStore.getSession(sessions[0].id);
        if (latest) {
          activeSessionId = latest.id;
          return latest;
        }
      }
      const created = await sessionStore.createSession(config.model);
      activeSessionId = created.id;
      return created;
    };

    const initialize = async () => {
      const session = await ensureSession(undefined);
      send(ws, {
        type: "session_active",
        sessionId: session.id,
      });
      await sendSessions();
    };

    await initialize();

    const abortRunningAgent = () => {
      if (currentAgentAbort) {
        // eslint-disable-next-line no-console
        console.log("[gateway] Aborting running agent");
        currentAgentAbort.abort();
        currentAgentAbort = null;
      }
    };

    // Session management commands run immediately (never blocked by a running agent).
    // Only "chat" is serialized through the queue.
    const handleSessionCommand = async (request: GatewayRequest) => {
      if (request.method === "sessions_list") {
        await sendSessions();
        return;
      }

      if (request.method === "session_create") {
        generation += 1;
        abortRunningAgent();
        const created = await sessionStore.createSession(config.model);
        activeSessionId = created.id;
        send(ws, { type: "session_active", sessionId: created.id });
        await sendSessions();
        return;
      }

      if (request.method === "session_switch") {
        generation += 1;
        abortRunningAgent();
        const existing = await sessionStore.getSession(request.sessionId);
        if (!existing) {
          send(ws, { type: "error", message: `Session not found: ${request.sessionId}` });
          return;
        }
        activeSessionId = existing.id;
        send(ws, { type: "session_active", sessionId: existing.id });
        await sendSessions();
        return;
      }

      if (request.method === "session_clear") {
        generation += 1;
        abortRunningAgent();
        const session = await ensureSession(request.sessionId);
        const cleared = await sessionStore.clearSession(session.id);
        if (!cleared) {
          send(ws, { type: "error", message: "Failed to clear session" });
          return;
        }
        send(ws, { type: "info", content: `Cleared session ${cleared.id}` });
        await sendSessions();
        return;
      }

      if (request.method === "refresh") {
        send(ws, {
          type: "info",
          content:
            "Refresh complete. Skills, policies, and memory are loaded fresh on every agent run.",
        });
        return;
      }
    };

    ws.on("message", (raw) => {
      let request: GatewayRequest;
      try {
        request = parseRequest(String(raw));
      } catch (error) {
        send(ws, { type: "error", message: `Bad request: ${String(error)}` });
        return;
      }

      // Session management commands bypass the queue — they always respond immediately
      if (request.method !== "chat") {
        handleSessionCommand(request).catch((error) => {
          send(ws, { type: "error", message: String(error) });
        });
        return;
      }

      // Chat requests are serialized so only one agent run happens at a time
      queue = queue
        .then(async () => {
          if (!request.message || !request.message.trim()) {
            send(ws, { type: "error", message: "message must be non-empty" });
            return;
          }

          const session = await ensureSession(request.sessionId);
          activeSessionId = session.id;
          send(ws, {
            type: "session_active",
            sessionId: session.id,
          });

          const abort = new AbortController();
          currentAgentAbort = abort;
          const runGeneration = generation;

          // Helper: true if user switched sessions since this run started
          const isStale = () => runGeneration !== generation;

          // eslint-disable-next-line no-console
          console.log(`[gateway] Agent run starting (session=${session.id}, gen=${runGeneration})`);

          try {
            await runAgent({
              config,
              session,
              userMessage: request.message,
              llm,
              tools,
              signal: abort.signal,
              onEvent: (event) => {
                // Suppress events from stale runs so they don't restart the CLI spinner
                if (isStale()) {
                  return;
                }

                if (event.type === "text") {
                  send(ws, { type: "text", content: event.content });
                  return;
                }
                if (event.type === "tool_call") {
                  send(ws, {
                    type: "tool_call",
                    name: event.name,
                    args: event.args,
                  });
                  return;
                }
                if (event.type === "tool_result") {
                  send(ws, {
                    type: "tool_result",
                    name: event.name,
                    content: event.content,
                    isError: event.isError,
                  });
                  return;
                }
                send(ws, {
                  type: "info",
                  content: event.content,
                });
              },
            });

            // eslint-disable-next-line no-console
            console.log(`[gateway] Agent run completed (session=${session.id}, gen=${runGeneration})`);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`[gateway] Agent run error: ${String(error)}`);
            if (!isStale()) {
              send(ws, { type: "error", message: String(error) });
            }
          } finally {
            currentAgentAbort = null;

            // Always save session — even if stale
            try {
              await sessionStore.saveSession(session);
            } catch (saveErr) {
              // eslint-disable-next-line no-console
              console.error(`[gateway] Session save error: ${String(saveErr)}`);
            }

            // Only send done if this run is still current — a stale done
            // would restart the spinner / confuse the CLI prompt state
            if (!isStale()) {
              send(ws, {
                type: "done",
                sessionId: session.id,
                tokenUsage: session.tokenUsage,
              });
              // eslint-disable-next-line no-console
              console.log(`[gateway] Done event sent (session=${session.id})`);
            } else {
              // eslint-disable-next-line no-console
              console.log(`[gateway] Suppressed stale done (session=${session.id}, gen=${runGeneration} vs current=${generation})`);
            }
          }
        })
        .catch((error) => {
          // Catch-all for unexpected errors in the queue
          // eslint-disable-next-line no-console
          console.error(`[gateway] Queue error: ${String(error)}`);
          send(ws, { type: "error", message: String(error) });
        });
    });
  });

  httpServer.listen(config.gatewayPort, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`FinOps gateway listening on http://127.0.0.1:${config.gatewayPort} (ws /ws)`);
    // eslint-disable-next-line no-console
    console.log(`Using project=${config.gcpProject} region=${config.gcpRegion} model=${config.model}`);
  });
}

runGateway().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`Gateway failed: ${String(error)}`);
  process.exit(1);
});
