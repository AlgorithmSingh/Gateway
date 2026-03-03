import chalk from "chalk";
import ora, { type Ora } from "ora";

// ── Color theme ──────────────────────────────────────────────────────

export const theme = {
  toolCall: chalk.cyan.bold,
  toolResult: chalk.green,
  toolError: chalk.red.bold,
  error: chalk.red.bold,
  info: chalk.gray,
  done: chalk.green.bold,
  session: chalk.yellow,
  prompt: chalk.blue.bold,
  radarPass: chalk.green.bold,
  radarFail: chalk.red.bold,
  radarWarn: chalk.yellow.bold,
  sep: chalk.dim,
} as const;

// ── Visual separators ────────────────────────────────────────────────

const SEP_W = 60;
const H = "\u2500"; // ─

export function separator(label?: string): string {
  if (!label) return theme.sep(H.repeat(SEP_W));
  const padded = `${H}${H} ${label} `;
  return theme.sep(padded + H.repeat(Math.max(0, SEP_W - padded.length)));
}

function boxTop(title: string): string {
  const inner = ` ${title} `;
  const pad = Math.max(0, SEP_W - inner.length - 2);
  return theme.sep("\u256D" + H) + chalk.bold(inner) + theme.sep(H.repeat(pad) + "\u256E");
}

function boxBottom(): string {
  return theme.sep("\u2570" + H.repeat(SEP_W) + "\u256F");
}

// ── Spinner ──────────────────────────────────────────────────────────

let spinner: Ora | null = null;

export function startSpinner(text = "Agent is thinking..."): void {
  stopSpinner();
  spinner = ora({
    text: chalk.dim(text),
    spinner: "dots",
    color: "cyan",
    // Keep commands responsive while spinner is active.
    discardStdin: false,
  }).start();
}

export function updateSpinnerText(text: string): void {
  if (spinner) spinner.text = chalk.dim(text);
}

export function stopSpinner(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

// ── Lightweight markdown renderer ────────────────────────────────────

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;

  for (const line of lines) {
    // fenced code block toggle
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      if (inCode) {
        out.push(theme.sep("  \u250C" + H.repeat(40)));
      } else {
        out.push(theme.sep("  \u2514" + H.repeat(40)));
      }
      continue;
    }

    if (inCode) {
      out.push(chalk.dim("  \u2502 ") + chalk.cyan(line));
      continue;
    }

    // headings
    if (/^### /.test(line)) {
      out.push(chalk.bold(line.slice(4)));
      continue;
    }
    if (/^## /.test(line)) {
      out.push(chalk.bold.underline(line.slice(3)));
      continue;
    }
    if (/^# /.test(line)) {
      out.push(chalk.bold.underline(line.slice(2)));
      continue;
    }

    // inline formatting
    let formatted = line;
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_m, p1: string) => chalk.bold(p1));
    formatted = formatted.replace(/`([^`]+)`/g, (_m, p1: string) => chalk.cyan(p1));

    // bullet points
    if (/^\s*[-*]\s/.test(formatted)) {
      formatted = formatted.replace(/^(\s*)[-*]\s/, "$1\u2022 ");
    }

    // table rows (basic markdown table)
    if (/^\|.*\|$/.test(formatted.trim())) {
      // separator rows
      if (/^\|[\s:|-]+\|$/.test(formatted.trim())) {
        out.push(theme.sep(H.repeat(SEP_W)));
        continue;
      }
      const cells = formatted
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      out.push(cells.join(chalk.dim("  \u2502  ")));
      continue;
    }

    out.push(formatted);
  }

  return out.join("\n") + "\n";
}

// ── Event formatters ─────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 3) + "...";
}

export function formatToolCall(name: string, args: Record<string, unknown> = {}): string {
  const argsStr = Object.keys(args).length > 0 ? " " + chalk.dim(JSON.stringify(args)) : "";
  return `  ${theme.toolCall("\u25B6 " + name)}${argsStr}`;
}

export function formatToolResult(name: string, content: string, isError: boolean): string {
  if (isError) {
    return `  ${theme.toolError("\u2718 " + name)} ${content}`;
  }
  return `  ${theme.toolResult("\u2714 " + name)} ${chalk.dim(truncate(content, 200))}`;
}

export function formatError(message: string): string {
  return `${theme.error("\u2718 Error:")} ${message}`;
}

export function formatInfo(content: string): string {
  return `${theme.info("\u2139 ")}${content}`;
}

export function formatDone(
  _sessionId: string,
  tokenUsage?: { input: number; output: number; total: number },
): string {
  const tokenStr = tokenUsage
    ? chalk.dim(` (tokens: ${tokenUsage.input} in / ${tokenUsage.output} out)`)
    : "";
  return theme.done("\u2714 Done") + tokenStr;
}

export function formatSessionList(
  sessions: Array<{ id: string; updatedAt: string; model: string; messageCount: number }>,
  activeSessionId?: string,
): string {
  const lines = [separator("Sessions")];
  for (const s of sessions) {
    const isActive = s.id === activeSessionId;
    const marker = isActive ? theme.session("\u25CF ") : chalk.dim("\u25CB ");
    const idStr = isActive ? theme.session(s.id) : s.id;
    lines.push(`${marker}${idStr}  ${chalk.dim(`model=${s.model}  msgs=${s.messageCount}  ${s.updatedAt}`)}`);
  }
  lines.push(separator());
  return lines.join("\n");
}

export function formatText(content: string): string {
  return renderMarkdown(content);
}

export function formatPrompt(shortSessionId: string): string {
  return `${theme.prompt(`[${shortSessionId}]`)} ${chalk.bold(">")} `;
}

export function formatHelp(): string {
  return [
    separator("Commands"),
    `  ${chalk.bold("/quit")}       Exit the CLI`,
    `  ${chalk.bold("/refresh")}    Reload skills, policies, memory`,
    `  ${chalk.bold("/clear")}      Clear session messages`,
    `  ${chalk.bold("/sessions")}   List all sessions`,
    `  ${chalk.bold("/new")}        Create a new session`,
    `  ${chalk.bold("/use")} ${chalk.dim("<id>")}   Switch to a session`,
    separator(),
  ].join("\n");
}

export function formatConnected(url: string): string {
  return `${theme.done("\u2714")} Connected to ${chalk.underline(url)}`;
}

export function formatBanner(params: {
  project: string;
  region: string;
  model: string;
  gatewayUrl: string;
}): string {
  const W = 58;
  const top = chalk.cyan("\u256D" + H.repeat(W) + "\u256E");
  const bot = chalk.cyan("\u2570" + H.repeat(W) + "\u256F");
  const side = chalk.cyan("\u2502");

  const pad = (s: string, width: number) => {
    // chalk-aware padding: strip ANSI to measure visible length
    // eslint-disable-next-line no-control-regex
    const visible = s.replace(/\u001B\[[0-9;]*m/g, "").length;
    const gap = Math.max(0, width - visible);
    return s + " ".repeat(gap);
  };

  const row = (content: string) => `${side} ${pad(content, W - 1)}${side}`;
  const empty = row("");

  const logo = [
    "  ____      _    ____    _    ____  ",
    " |  _ \\    / \\  |  _ \\  / \\  |  _ \\ ",
    " | |_) |  / _ \\ | | | |/ _ \\ | |_) |",
    " |  _ <  / ___ \\| |_| / ___ \\|  _ < ",
    " |_| \\_\\/_/   \\_\\____/_/   \\_\\_| \\_\\",
  ];

  const lines: string[] = [];
  lines.push("");
  lines.push(top);
  for (const l of logo) {
    lines.push(row(chalk.cyan.bold(l)));
  }
  lines.push(empty);
  lines.push(row(chalk.bold("  FinOps Agent") + chalk.dim("  \u2022  Resource Analysis & Detection")));
  lines.push(empty);
  lines.push(row(`  ${chalk.dim("Project")}   ${chalk.white(params.project)}`));
  lines.push(row(`  ${chalk.dim("Region")}    ${chalk.white(params.region)}`));
  lines.push(row(`  ${chalk.dim("Model")}     ${chalk.white(params.model)}`));
  lines.push(row(`  ${chalk.dim("Gateway")}   ${chalk.green(params.gatewayUrl)}`));
  lines.push(empty);
  lines.push(bot);
  lines.push("");

  return lines.join("\n");
}

// ── RADAR report ─────────────────────────────────────────────────────

type CostComplianceToolResult = {
  status: "pass" | "fail";
  summary: { passedChecks: number; failedChecks: number; totalChecks: number };
  inputs: { planPath: string; costDataPath: string; policyPath?: string };
  outputs: { complianceResultPath: string; reportPath: string };
};

export function parseCostComplianceResult(
  toolName: string,
  content: string,
): CostComplianceToolResult | null {
  if (toolName !== "cost_compliance") return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed.status === "string" &&
      parsed.summary &&
      typeof (parsed.summary as Record<string, unknown>).totalChecks === "number"
    ) {
      return parsed as unknown as CostComplianceToolResult;
    }
  } catch {
    // not parseable
  }
  return null;
}

export function formatRadarReport(result: CostComplianceToolResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(boxTop("\uD83C\uDFAF RADAR Analysis Complete"));
  lines.push("");

  // Status
  const isPassing = result.status === "pass";
  const statusIcon = isPassing ? "\u2705" : "\u26A0\uFE0F";
  const statusText = isPassing ? "All Clear" : "Attention Required";
  const statusColor = isPassing ? theme.radarPass : theme.radarWarn;
  lines.push(`  Status: ${statusIcon} ${statusColor(statusText)}`);
  lines.push("");

  // Policy compliance
  lines.push(`  ${chalk.bold("Policy Compliance")}`);
  if (result.summary.failedChecks > 0) {
    lines.push(`  ${theme.radarFail(`\u274C ${result.summary.failedChecks} violation(s) found`)}`);
  } else {
    lines.push(`  ${theme.radarPass(`\u2714 All ${result.summary.totalChecks} checks passed`)}`);
  }
  lines.push(
    `  ${chalk.dim(`(${result.summary.passedChecks} passed, ${result.summary.failedChecks} failed, ${result.summary.totalChecks} total)`)}`,
  );
  lines.push("");

  // Artifacts
  lines.push(`  ${chalk.bold("Artifacts")}`);
  lines.push(`  \u2022 Compliance JSON: ${chalk.underline(result.outputs.complianceResultPath)}`);
  lines.push(`  \u2022 Markdown Report: ${chalk.underline(result.outputs.reportPath)}`);
  lines.push("");
  lines.push(boxBottom());
  lines.push("");

  return lines.join("\n");
}
