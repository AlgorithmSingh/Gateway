import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import {
  formatToolCall,
  formatToolResult,
  formatError,
  formatInfo,
  formatDone,
  formatSessionList,
  formatText,
  formatHelp,
  formatConnected,
  formatPrompt,
  parseCostComplianceResult,
  formatRadarReport,
  formatBanner,
  startSpinner,
  stopSpinner,
} from "./cli-format.js";

type GatewayEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; name: string; content: string; isError?: boolean }
  | { type: "info"; content: string }
  | { type: "error"; message: string }
  | {
      type: "sessions";
      sessions: Array<{
        id: string;
        updatedAt: string;
        model: string;
        messageCount: number;
      }>;
      activeSessionId?: string;
    }
  | { type: "session_active"; sessionId: string }
  | { type: "done"; sessionId: string; tokenUsage?: { input: number; output: number; total: number } };

function parseEvent(raw: WebSocket.RawData): GatewayEvent | null {
  try {
    return JSON.parse(String(raw)) as GatewayEvent;
  } catch {
    return null;
  }
}

function shortSession(id?: string): string {
  if (!id) {
    return "none";
  }
  if (id.length <= 14) {
    return id;
  }
  // Include both head and tail to avoid collisions for sessions created close in time.
  return `${id.slice(0, 10)}...${id.slice(-4)}`;
}

async function runCli(): Promise<void> {
  const configPath = process.env.FINOPS_CONFIG
    ? path.resolve(process.env.FINOPS_CONFIG)
    : path.resolve(process.cwd(), "config.json");
  const config = loadConfig(configPath);
  const gatewayUrl = process.env.FINOPS_GATEWAY_URL ?? `ws://127.0.0.1:${config.gatewayPort}/ws`;

  const ws = new WebSocket(gatewayUrl);

  let activeSessionId: string | undefined;
  let busy = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const updatePrompt = () => {
    rl.setPrompt(formatPrompt(shortSession(activeSessionId)));
  };

  const printHelp = () => {
    process.stdout.write(formatHelp() + "\n");
  };

  const send = (payload: Record<string, unknown>): boolean => {
    if (ws.readyState !== WebSocket.OPEN) {
      process.stderr.write(formatError("Gateway connection is not open.") + "\n");
      return false;
    }

    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      process.stderr.write(formatError(`Failed to send request: ${String(error)}`) + "\n");
      return false;
    }
  };

  ws.on("open", () => {
    process.stdout.write(
      formatBanner({
        project: config.gcpProject,
        region: config.gcpRegion,
        model: config.model,
        gatewayUrl,
      }),
    );
    printHelp();
    send({ method: "sessions_list" });
    updatePrompt();
    rl.prompt();
  });

  ws.on("message", (raw) => {
    const evt = parseEvent(raw);
    if (!evt) {
      stopSpinner();
      process.stdout.write(String(raw) + "\n");
      rl.prompt();
      return;
    }

    if (evt.type === "text") {
      stopSpinner();
      process.stdout.write(formatText(evt.content));
      // No prompt — more text chunks may follow. Prompt appears on "done".
      return;
    }

    if (evt.type === "tool_call") {
      stopSpinner();
      process.stdout.write(formatToolCall(evt.name, evt.args) + "\n");
      startSpinner(`Running ${evt.name}...`);
      return;
    }

    if (evt.type === "tool_result") {
      stopSpinner();

      const complianceData = parseCostComplianceResult(evt.name, evt.content);
      if (complianceData) {
        process.stdout.write(formatRadarReport(complianceData));
      } else {
        process.stdout.write(
          formatToolResult(evt.name, evt.content, evt.isError ?? false) + "\n",
        );
      }

      startSpinner("Agent is thinking...");
      return;
    }

    if (evt.type === "sessions") {
      stopSpinner();
      if (evt.activeSessionId) {
        activeSessionId = evt.activeSessionId;
      }
      process.stdout.write(formatSessionList(evt.sessions, activeSessionId) + "\n");
      updatePrompt();
      rl.prompt();
      return;
    }

    if (evt.type === "session_active") {
      stopSpinner();
      activeSessionId = evt.sessionId;
      process.stdout.write(formatInfo(`Active session: ${evt.sessionId}`) + "\n");
      updatePrompt();
      rl.prompt();
      return;
    }

    if (evt.type === "done") {
      stopSpinner();
      busy = false;
      process.stdout.write(formatDone(evt.sessionId, evt.tokenUsage) + "\n");
      rl.prompt();
      return;
    }

    if (evt.type === "error") {
      stopSpinner();
      busy = false;
      process.stderr.write(formatError(evt.message) + "\n");
      rl.prompt();
      return;
    }

    stopSpinner();
    process.stdout.write(formatInfo(evt.content) + "\n");
    rl.prompt();
  });

  ws.on("close", () => {
    stopSpinner();
    process.stdout.write(formatInfo("Disconnected from gateway.") + "\n");
    process.exit(0);
  });

  ws.on("error", (error) => {
    stopSpinner();
    process.stderr.write(formatError(`WebSocket error: ${String(error)}`) + "\n");
  });

  rl.on("line", (input) => {
    const line = input.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line === "/quit") {
      rl.close();
      ws.close();
      return;
    }

    if (line === "/refresh") {
      send({ method: "refresh" });
      rl.prompt();
      return;
    }

    if (line === "/clear") {
      stopSpinner();
      busy = false;
      send({ method: "session_clear", sessionId: activeSessionId });
      rl.prompt();
      return;
    }

    if (line === "/sessions") {
      stopSpinner();
      send({ method: "sessions_list" });
      rl.prompt();
      return;
    }

    if (line === "/new") {
      stopSpinner();
      busy = false;
      process.stdout.write(formatInfo("Requesting new session...") + "\n");
      send({ method: "session_create" });
      rl.prompt();
      return;
    }

    if (line.startsWith("/use ")) {
      const sessionId = line.slice(5).trim();
      if (!sessionId) {
        process.stdout.write("Usage: /use <sessionId>\n");
        rl.prompt();
        return;
      }
      send({ method: "session_switch", sessionId });
      rl.prompt();
      return;
    }

    if (line.startsWith("/")) {
      process.stdout.write(`Unknown command: ${line}\n`);
      printHelp();
      rl.prompt();
      return;
    }

    if (busy) {
      process.stdout.write("Agent is running. Wait for done before sending another message.\n");
      rl.prompt();
      return;
    }

    busy = true;
    startSpinner("Agent is thinking...");
    send({
      method: "chat",
      message: line,
      sessionId: activeSessionId,
    });
  });
}

runCli().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`CLI failed: ${String(error)}`);
  process.exit(1);
});
