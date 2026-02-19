/**
 * Convos Agent Extension for Pi
 *
 * Bridges `convos agent serve` with pi's agent loop, enabling AI agents
 * to have real-time Convos conversations while doing other work.
 *
 * How it works:
 * - Spawns `convos agent serve` as a child process
 * - Streams incoming messages and injects them via pi.sendMessage()
 * - Registers `convos_send` and `convos_react` tools for the LLM to reply
 * - Messages from Convos users interrupt the agent as new turns
 *
 * Modes:
 *   Interactive (TUI) — user starts with /convos-start command
 *   Headless — auto-starts on session_start when no UI is available
 *
 * Headless mode is configured via environment variables:
 *   CONVOS_ENV_FILE     — Path to .env file for convos CLI (auto-created if missing)
 *   CONVOS_NAME         — Conversation name (default: derived from project/branch)
 *   CONVOS_PROFILE_NAME — Profile name shown to other members (default: "Pi")
 *
 * Commands (interactive only):
 *   /convos-start [args]  — Start the agent (args passed to `convos agent serve`)
 *   /convos-stop          — Stop the agent
 *   /convos-status        — Show agent status
 *
 * Requires @convos/cli to be installed: npm install -g @convos/cli
 */

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let agentProcess: ChildProcess | null = null;
  let stdinWriter: ((cmd: object) => void) | null = null;
  let conversationId: string | null = null;
  let qrCodePath: string | null = null;
  let inviteUrl: string | null = null;
  let rl: Interface | null = null;
  let isReady = false;
  let lastMessageFromConvos = false;
  let headlessMode = false;

  // Headless catch-up state
  let lastSeenTimestampNs: string | null = null;
  let ownInboxId: string | null = null;

  // Resolve worktree root eagerly at load time
  let worktreeRoot: string | null = null;
  try {
    worktreeRoot = execSync("git rev-parse --show-toplevel", {
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
  } catch {
    // Not in a git repo
  }

  // --- Headless env config ---
  const convosEnvFile = process.env.CONVOS_ENV_FILE || null;
  const convosName = process.env.CONVOS_NAME || null;
  const convosProfileName = process.env.CONVOS_PROFILE_NAME || "Pi";

  // --- Config persistence ---

  function getConvosConfigPath(): string | null {
    // Headless: store alongside the env file
    if (convosEnvFile) {
      return join(dirname(convosEnvFile), "convos-session.json");
    }
    // Interactive: store in .pi/ inside worktree
    if (!worktreeRoot) return null;
    return join(worktreeRoot, ".pi", "convos.json");
  }

  interface PersistedState {
    conversationId: string;
    inviteUrl?: string | null;
    lastSeenTimestampNs?: string | null;
  }

  function loadPersistedState(): PersistedState | null {
    const configPath = getConvosConfigPath();
    if (!configPath || !existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as PersistedState;
    } catch {
      return null;
    }
  }

  function loadPersistedConversation(): string | null {
    return loadPersistedState()?.conversationId ?? null;
  }

  function persistState() {
    if (!conversationId) return;
    const configPath = getConvosConfigPath();
    if (!configPath) return;
    mkdirSync(dirname(configPath), { recursive: true });
    const state: PersistedState = {
      conversationId,
      inviteUrl,
      lastSeenTimestampNs,
    };
    writeFileSync(configPath, JSON.stringify(state, null, 2) + "\n");
  }

  function getDefaultConversationName(): string {
    // Get project name from directory
    const projectName = worktreeRoot ? worktreeRoot.split("/").pop() ?? "project" : "project";

    // Get branch name
    let branch: string | null = null;
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        stdio: ["pipe", "pipe", "pipe"],
      }).toString().trim();
    } catch {
      // Not in a git repo or no branch
    }

    // If on a non-default branch, summarize it
    if (branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
      // Convert branch name like "feature/add-auth-system" to "add auth"
      const summary = branch
        .replace(/^(feature|fix|bugfix|hotfix|chore|refactor|docs)\//i, "")
        .replace(/[-_/]/g, " ")
        .split(" ")
        .slice(0, 2)
        .join(" ");
      return `${projectName} — ${summary}`;
    }

    return projectName;
  }

  // --- Headless: Convos identity init ---

  function ensureConvosInit() {
    if (!convosEnvFile) return;
    if (existsSync(convosEnvFile)) return;
    mkdirSync(dirname(convosEnvFile), { recursive: true });
    execSync(`convos init --env dev --output ${convosEnvFile} --force`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // --- Headless: Catch-up on missed messages ---

  function getOwnInboxId(): string | null {
    if (!convosEnvFile) return null;
    try {
      const output = execSync(`convos identity list --env-file ${convosEnvFile} --json`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const identities = JSON.parse(output);
      if (identities.length > 0) return identities[0].inboxId;
    } catch {}
    return null;
  }

  function catchUpOnMissedMessages() {
    if (!conversationId || !convosEnvFile || !lastSeenTimestampNs) return;

    try {
      let cmd = `convos conversation messages ${conversationId} --sync --json --limit 50 --direction ascending --content-type text --env-file ${convosEnvFile}`;
      cmd += ` --sent-after ${lastSeenTimestampNs}`;

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const messages = JSON.parse(output);
      if (!messages || messages.length === 0) return;

      // Get own inbox ID to filter out our messages
      if (!ownInboxId) ownInboxId = getOwnInboxId();

      const missed = messages.filter((msg: any) =>
        msg.senderInboxId !== ownInboxId &&
        msg.content?.text
      );

      if (missed.length === 0) return;

      console.log(`\n📬 ${missed.length} missed message(s) from Convos:`);

      const summary = missed.map((msg: any) => {
        const text = msg.content?.text || msg.content;
        console.log(`   💬 ${msg.senderInboxId}: ${text}`);
        return `[${msg.senderInboxId}]: ${text}`;
      }).join("\n");

      // Update lastSeen to the newest message
      const newest = messages[messages.length - 1];
      if (newest?.sentAtNs) {
        lastSeenTimestampNs = newest.sentAtNs;
        persistState();
      }

      // Inject as a single steer message
      lastMessageFromConvos = true;
      pi.sendUserMessage(
        `[Missed Convos messages while you were offline]:\n${summary}\n\nReview these messages. If any need a response, reply via convos_send. Then continue with your work.`,
        { deliverAs: "steer" },
      );
    } catch (err) {
      console.error("⚠ Failed to catch up on missed messages:", err);
    }
  }

  // Track when a convos message triggers a turn vs terminal input
  pi.on("input", async (event) => {
    if (event.source === "interactive") {
      lastMessageFromConvos = false;
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!isReady) return;

    // In headless mode, all messages from the agent are potentially for Convos
    if (headlessMode) {
      if (lastMessageFromConvos) {
        return {
          systemPrompt: event.systemPrompt +
            "\n\nThe current message is from a Convos user. Reply using the convos_send tool. Do NOT use markdown — Convos renders plain text only.",
        };
      }
      return;
    }

    if (lastMessageFromConvos) {
      return {
        systemPrompt: event.systemPrompt +
          "\n\nThe current message is from a Convos user. Reply using the convos_send tool. Do NOT use markdown — Convos renders plain text only.",
      };
    } else {
      return {
        systemPrompt: event.systemPrompt +
          "\n\nThe current message is from the terminal. Respond normally as plain text output. Do NOT use convos_send or convos_react — those are only for Convos messages.",
      };
    }
  });

  function startAgent(args: string[]) {
    // Use globally installed convos CLI
    const proc = spawn("convos", ["agent", "serve", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    agentProcess = proc;

    stdinWriter = (cmd: object) => {
      if (proc.stdin?.writable) {
        proc.stdin.write(JSON.stringify(cmd) + "\n");
      }
    };

    // Read stdout line by line for ndjson events
    rl = createInterface({ input: proc.stdout!, terminal: false });

    rl.on("line", (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      switch (event.event) {
        case "ready":
          isReady = true;
          conversationId = event.conversationId;
          qrCodePath = event.qrCodePath;
          inviteUrl = event.inviteUrl;
          persistState();

          if (headlessMode) {
            // Log to stdout for headless consumers
            console.log(`\n🔗 Convos ready: ${conversationId}`);
            if (inviteUrl) console.log(`📱 Invite: ${inviteUrl}`);

            // Show QR code inline (iTerm2 protocol) if available
            if (qrCodePath) {
              try {
                const imageData = readFileSync(qrCodePath);
                const base64 = imageData.toString("base64");
                const filename = Buffer.from(qrCodePath).toString("base64");
                process.stdout.write(`\x1b]1337;File=name=${filename};inline=1;width=auto;preserveAspectRatio=1:${base64}\x07\n\n`);
              } catch {}
            }

            // Catch up on missed messages from previous sessions
            catchUpOnMissedMessages();

            pi.sendMessage({
              customType: "convos",
              content: `Convos agent is ready. Conversation: ${conversationId}. Use convos_send to message the human.`,
              display: false,
            }, { triggerTurn: false });
          } else {
            pi.sendMessage(
              {
                customType: "convos",
                content: [
                  `Convos agent is ready and listening for messages.`,
                  `Conversation: ${conversationId}`,
                  `Invite URL: ${inviteUrl}`,
                  ``,
                  `IMPORTANT: Only use convos_send/convos_react to reply to messages from Convos (prefixed with "[Convos message from ...]"). For messages from the terminal, respond normally as plain text without using convos tools.`,
                ].join("\n"),
                display: true,
                details: { type: "ready", conversationId, inviteUrl, qrCodePath },
              },
              { triggerTurn: true },
            );
          }
          break;

        case "message":

          lastMessageFromConvos = true;

          // Track latest message timestamp for catch-up
          if (event.sentAtNs) {
            lastSeenTimestampNs = event.sentAtNs;
            persistState();
          }

          // Check if this is an attachment message
          const attachMatch = event.content?.match(/^\[remote attachment: (.+?) \(.*?\) (https?:\/\/\S+)\]$/);
          if (attachMatch && conversationId) {
            // Download the attachment
            const filename = attachMatch[1];
            const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename);

            if (isImage) {
              // Download to temp file
              const tmpDir = join(worktreeRoot ?? "/tmp", ".pi");
              mkdirSync(tmpDir, { recursive: true });
              const outputPath = join(tmpDir, `convos-attachment-${event.id}-${filename}`);

              const downloadArgs = convosEnvFile ? ` --env-file ${convosEnvFile}` : "";
              try {
                execSync(
                  `convos conversation download-attachment ${conversationId} ${event.id} -o "${outputPath}"${downloadArgs}`,
                  { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 },
                );

                // Read image and encode as base64
                const imageData = readFileSync(outputPath);
                const base64 = imageData.toString("base64");
                const ext = filename.split(".").pop()?.toLowerCase() ?? "jpeg";
                const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

                lastMessageFromConvos = true;
                pi.sendUserMessage([
                  { type: "text", text: `[Convos image from ${event.senderInboxId}] ${filename}` },
                  { type: "image", data: base64, mimeType },
                ], { deliverAs: "steer" });

                // Clean up temp file
                try { unlinkSync(outputPath); } catch {}
              } catch (e) {
                // Download failed, send as text
                pi.sendMessage(
                  {
                    customType: "convos",
                    content: `[Convos message from ${event.senderInboxId}] Sent an image (${filename}) but download failed.`,
                    display: true,
                    details: {
                      type: "message",
                      id: event.id,
                      senderInboxId: event.senderInboxId,
                      contentType: event.contentType,
                      content: event.content,
                      sentAt: event.sentAt,
                    },
                  },
                  { triggerTurn: true, deliverAs: "steer" },
                );
              }
              break;
            }
          }

          if (headlessMode) {
            console.log(`\n💬 Convos message from ${event.senderInboxId}: ${event.content}`);
          }

          pi.sendMessage(
            {
              customType: "convos",
              content: `[Convos message from ${event.senderInboxId}] ${event.content}`,
              display: true,
              details: {
                type: "message",
                id: event.id,
                senderInboxId: event.senderInboxId,
                contentType: event.contentType,
                content: event.content,
                sentAt: event.sentAt,
              },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          break;

        case "member_joined":
          if (headlessMode) {
            console.log(`\n✅ Member joined: ${event.inboxId}`);
          }

          pi.sendMessage(
            {
              customType: "convos",
              content: `[Convos] New member joined: ${event.inboxId}`,
              display: true,
              details: { type: "member_joined", inboxId: event.inboxId },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          break;

        case "sent":
          // Delivery confirmation — no need to trigger a turn
          break;

        case "error":
          if (headlessMode) {
            console.error(`\n⚠ Convos error: ${event.message}`);
          }

          pi.sendMessage(
            {
              customType: "convos",
              content: `[Convos error] ${event.message}`,
              display: true,
              details: { type: "error", message: event.message },
            },
            { triggerTurn: false },
          );
          break;
      }
    });

    // Capture stderr for diagnostics/errors
    const stderrLines: string[] = [];
    if (proc.stderr) {
      createInterface({ input: proc.stderr, terminal: false }).on("line", (line: string) => {
        stderrLines.push(line);
        // Keep only last 50 lines
        if (stderrLines.length > 50) stderrLines.shift();
      });
    }

    proc.on("exit", (code) => {
      const wasReady = isReady;
      isReady = false;
      agentProcess = null;
      stdinWriter = null;
      rl?.close();
      rl = null;

      if (!wasReady && code !== 0) {
        // Process died before becoming ready — likely an error
        const errorDetail = stderrLines.length > 0
          ? `\nStderr:\n${stderrLines.join("\n")}`
          : "";

        if (headlessMode) {
          console.error(`⚠ Convos agent exited with code ${code} before ready.${errorDetail}`);
        }

        pi.sendMessage(
          {
            customType: "convos",
            content: `[Convos] Agent process exited with code ${code} before becoming ready.${errorDetail}`,
            display: true,
            details: { type: "error", code, stderr: stderrLines },
          },
          { triggerTurn: false },
        );
      } else if (wasReady) {
        if (headlessMode) {
          console.log(`\n🔗 Convos agent exited (code ${code}).`);
        }

        pi.sendMessage(
          {
            customType: "convos",
            content: `[Convos] Agent process exited (code ${code}).`,
            display: true,
            details: { type: "exit", code },
          },
          { triggerTurn: false },
        );
      }
    });
  }

  function stopAgent() {
    if (agentProcess) {
      stdinWriter?.({ type: "stop" });
      const proc = agentProcess;
      setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
      }, 2000);
      agentProcess = null;
      stdinWriter = null;
      isReady = false;
      rl?.close();
      rl = null;
    }
  }

  // --- Auto-start in headless mode ---

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) return; // Interactive mode uses /convos-start

    headlessMode = true;

    // Check that convos CLI is available
    try {
      execSync("which convos", { stdio: "ignore" });
    } catch {
      console.error("⚠ convos CLI not found. Install it: npm install -g @convos/cli");
      return;
    }

    try {
      // Initialize convos identity if env file is configured but doesn't exist
      if (convosEnvFile) {
        ensureConvosInit();
      }

      const args: string[] = [];

      // Add env-file if configured
      if (convosEnvFile) {
        args.push("--env-file", convosEnvFile);
      }

      // Restore previous session state
      const savedState = loadPersistedState();
      if (savedState?.lastSeenTimestampNs) {
        lastSeenTimestampNs = savedState.lastSeenTimestampNs;
      }

      if (savedState?.conversationId) {
        // Resume existing conversation
        args.push(savedState.conversationId);
      } else {
        // Create new conversation
        const name = convosName || getDefaultConversationName();
        args.push("--name", name, "--profile-name", convosProfileName);
      }

      startAgent(args);
    } catch (err) {
      console.error("⚠ Convos auto-start failed:", err);
    }
  });

  // --- Tools ---

  pi.registerTool({
    name: "convos_send",
    label: "Convos Send",
    description:
      "Send a message to the active Convos conversation. Only use when the system prompt says the current message is from Convos. Never use markdown — Convos renders plain text only.",
    parameters: Type.Object({
      text: Type.String({ description: "The message text to send" }),
      replyTo: Type.Optional(
        Type.String({ description: "Message ID to reply to (optional)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!stdinWriter || !isReady) {
        return {
          content: [{ type: "text", text: headlessMode
            ? "Convos agent is not running."
            : "Convos agent is not running. Use /convos-start to start it."
          }],
          isError: true,
        };
      }
      const cmd: any = { type: "send", text: params.text };
      if (params.replyTo) cmd.replyTo = params.replyTo;
      stdinWriter(cmd);

      // Update lastSeen to now so we don't re-fetch our own messages on catch-up
      lastSeenTimestampNs = String(Date.now() * 1_000_000);
      persistState();

      return {
        content: [
          {
            type: "text",
            text: `Sent: "${params.text}"${params.replyTo ? ` (reply to ${params.replyTo})` : ""}`,
          },
        ],
        details: { text: params.text, replyTo: params.replyTo },
      };
    },
  });

  pi.registerTool({
    name: "convos_react",
    label: "Convos React",
    description: "Send a reaction emoji to a message in the active Convos conversation.",
    parameters: Type.Object({
      messageId: Type.String({ description: "The message ID to react to" }),
      emoji: Type.String({ description: "The reaction emoji (e.g. 👍, ❤️, 😂)" }),
      action: Type.Optional(
        Type.Union([Type.Literal("add"), Type.Literal("remove")], {
          description: "Whether to add or remove the reaction (default: add)",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!stdinWriter || !isReady) {
        return {
          content: [{ type: "text", text: "Convos agent is not running." }],
          isError: true,
        };
      }
      const cmd: any = { type: "react", messageId: params.messageId, emoji: params.emoji };
      if (params.action) cmd.action = params.action;
      stdinWriter(cmd);
      return {
        content: [{ type: "text", text: `Reacted with ${params.emoji} to message ${params.messageId}` }],
      };
    },
  });

  pi.registerTool({
    name: "convos_send_file",
    label: "Convos Send File",
    description: "Send a file to the active Convos conversation as an attachment.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to file to send" }),
    }),
    async execute(_toolCallId, params) {
      if (!conversationId || !isReady) {
        return {
          content: [{ type: "text", text: "Convos agent is not running." }],
          isError: true,
        };
      }
      try {
        const envArg = convosEnvFile ? ` --env-file ${convosEnvFile}` : "";
        execSync(
          `convos conversation send-attachment ${conversationId} ${params.file}${envArg}`,
          { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
        );
        return {
          content: [{ type: "text", text: `File sent: ${params.file}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to send file: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // --- Message Renderer ---

  pi.registerMessageRenderer("convos", (message, _options, theme) => {
    const details = message.details as any;
    let output = "";

    if (details?.type === "ready" && details.qrCodePath) {
      // Render QR code image inline using iTerm2 inline image protocol
      try {
        const imageData = readFileSync(details.qrCodePath);
        const base64 = imageData.toString("base64");
        const filename = Buffer.from(details.qrCodePath).toString("base64");
        output += `\x1b]1337;File=name=${filename};inline=1;width=auto;preserveAspectRatio=1:${base64}\x07\n\n`;
      } catch {
        // Fall back to showing the path if we can't read the image
        output += theme.fg("dim", `QR code: ${details.qrCodePath}`) + "\n\n";
      }
      output += theme.fg("accent", "Convos agent is ready") + "\n";
      output += theme.fg("dim", `Conversation: `) + details.conversationId + "\n";
      output += theme.fg("dim", `Invite URL: `) + details.inviteUrl;
    } else {
      output = message.content;
    }

    return new Text(output, 0, 0);
  });

  // --- Commands (interactive mode only) ---

  pi.registerCommand("convos-start", {
    description:
      'Start the Convos agent. Pass flags for `convos agent serve`, e.g.: /convos-start --name "Bot" --profile-name "🤖 AI"',
    handler: async (args, ctx) => {
      if (agentProcess) {
        ctx.ui.notify("Convos agent is already running", "warning");
        return;
      }

      // Check that convos CLI is installed
      try {
        const { execSync } = await import("node:child_process");
        execSync("which convos", { stdio: "ignore" });
      } catch {
        ctx.ui.notify(
          "convos CLI not found. Install it: npm install -g @convos/cli",
          "error",
        );
        return;
      }

      const argList = args
        ? args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? []
        : [];

      // If no conversation ID provided as argument, try to reuse persisted one
      const hasConversationArg = argList.some((a) => !a.startsWith("-"));
      const persistedId = loadPersistedConversation();

      if (!hasConversationArg && persistedId) {
        // Attach to existing conversation
        argList.unshift(persistedId);
        ctx.ui.notify(`Resuming conversation ${persistedId}...`, "info");
      } else if (!hasConversationArg) {
        // New conversation — derive name from project and branch
        const convName = convosName || getDefaultConversationName();
        argList.push("--name", convName, "--profile-name", convosProfileName);
        ctx.ui.notify(`Starting new Convos conversation: ${convName}...`, "info");
      } else {
        ctx.ui.notify("Starting Convos agent...", "info");
      }

      startAgent(argList);
    },
  });

  pi.registerCommand("convos-stop", {
    description: "Stop the Convos agent",
    handler: async (_args, ctx) => {
      if (!agentProcess) {
        ctx.ui.notify("Convos agent is not running", "info");
        return;
      }
      stopAgent();
      ctx.ui.notify("Convos agent stopped", "info");
    },
  });

  pi.registerCommand("convos-status", {
    description: "Show Convos agent status and QR code",
    handler: async (_args, ctx) => {
      if (!agentProcess || !isReady) {
        ctx.ui.notify("Convos agent is not running", "info");
      } else {
        pi.sendMessage(
          {
            customType: "convos",
            content: [
              `Convos agent is running.`,
              `Conversation: ${conversationId}`,
              `Invite URL: ${inviteUrl}`,
            ].join("\n"),
            display: true,
            details: { type: "ready", conversationId, inviteUrl, qrCodePath },
          },
          { triggerTurn: false },
        );
      }
    },
  });

  // --- Lifecycle ---

  pi.on("session_shutdown", async () => {
    // Persist latest timestamp before shutdown
    if (headlessMode) {
      lastSeenTimestampNs = String(Date.now() * 1_000_000);
      persistState();
    }
    stopAgent();
  });
}
