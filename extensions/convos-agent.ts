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
 * Commands:
 *   /convos-start [args]  — Start the agent (args passed to `convos agent serve`)
 *   /convos-stop          — Stop the agent
 *   /convos-status        — Show agent status
 *
 * Requires @convos/cli to be installed: npm install -g @convos/cli
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let agentProcess: ChildProcess | null = null;
  let stdinWriter: ((cmd: object) => void) | null = null;
  let conversationId: string | null = null;
  let qrCodePath: string | null = null;
  let inviteUrl: string | null = null;
  let rl: Interface | null = null;
  let isReady = false;

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
          pi.sendMessage(
            {
              customType: "convos",
              content: [
                `Convos agent is ready and listening for messages.`,
                `Conversation: ${conversationId}`,
                `Invite URL: ${inviteUrl}`,
                `QR code: ${qrCodePath}`,
                ``,
                `Use the read tool on the QR code path to display it inline for the user.`,
                `Use convos_send to reply to messages. Use convos_react to react.`,
              ].join("\n"),
              display: true,
              details: { type: "ready", conversationId, inviteUrl, qrCodePath },
            },
            { triggerTurn: true },
          );
          break;

        case "message":
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

    // Silently consume stderr (QR code path + diagnostics)
    if (proc.stderr) {
      createInterface({ input: proc.stderr, terminal: false }).on("line", () => {});
    }

    proc.on("exit", (code) => {
      isReady = false;
      agentProcess = null;
      stdinWriter = null;
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

  // --- Tools ---

  pi.registerTool({
    name: "convos_send",
    label: "Convos Send",
    description:
      "Send a message to the active Convos conversation. Use this to reply to messages received from Convos users.",
    parameters: Type.Object({
      text: Type.String({ description: "The message text to send" }),
      replyTo: Type.Optional(
        Type.String({ description: "Message ID to reply to (optional)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!stdinWriter || !isReady) {
        return {
          content: [{ type: "text", text: "Convos agent is not running. Use /convos-start to start it." }],
          isError: true,
        };
      }
      const cmd: any = { type: "send", text: params.text };
      if (params.replyTo) cmd.replyTo = params.replyTo;
      stdinWriter(cmd);
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

  // --- Commands ---

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
        : ["--name", "Chat with Agent", "--profile-name", "🤖 Agent"];
      startAgent(argList);
      ctx.ui.notify("Starting Convos agent...", "info");
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
    description: "Show Convos agent status",
    handler: async (_args, ctx) => {
      if (!agentProcess || !isReady) {
        ctx.ui.notify("Convos agent is not running", "info");
      } else {
        ctx.ui.notify(
          `Convos agent running | Conversation: ${conversationId} | Invite: ${inviteUrl}`,
          "info",
        );
      }
    },
  });

  // --- Lifecycle ---

  pi.on("session_shutdown", async () => {
    stopAgent();
  });
}
