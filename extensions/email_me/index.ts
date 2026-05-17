/**
 * email_me - Pi extension for sending email notifications via SMTP
 *
 * Configuration is read from the .env file in this directory (falls back to
 * environment variables if already set):
 *
 *   EMAIL_ME_USER     - SMTP login / email address         (required)
 *   EMAIL_ME_PASS     - SMTP password or app password      (required)
 *   EMAIL_ME_TO       - Recipient email address            (required)
 *   EMAIL_ME_HOST     - SMTP server host                   (default: smtp.gmail.com)
 *   EMAIL_ME_PORT     - SMTP server port                   (default: 587)
 *   EMAIL_ME_FROM     - "From" address                     (default: same as EMAIL_ME_USER)
 *   EMAIL_ME_SUBJECT_PREFIX - Prefix for subject lines     (default: "[pi]")
 *
 * Copy .env.template to .env and fill in your values.
 * Environment variables take precedence over .env file values.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Load .env file (only sets vars not already in process.env) ──────────────
function loadEnvFile(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Normalize any funky unicode whitespace (NBSP etc) in passwords —
    // Google renders app passwords with non-breaking spaces in the UI
    if (key === "EMAIL_ME_PASS") {
      value = value.replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ").trim();
    }

    // Environment variable takes precedence
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
loadEnvFile();

type SendResult = { messageId: string; accepted: string[]; rejected: string[] };

function getConfig() {
  const user = process.env.EMAIL_ME_USER;
  const pass = process.env.EMAIL_ME_PASS;
  const to = process.env.EMAIL_ME_TO;

  return {
    host: process.env.EMAIL_ME_HOST || "smtp.gmail.com",
    port: parseInt(process.env.EMAIL_ME_PORT || "587", 10),
    user,
    pass,
    from: process.env.EMAIL_ME_FROM || user,
    to,
    subjectPrefix: process.env.EMAIL_ME_SUBJECT_PREFIX || "[pi]",
  };
}

function validateConfig(config: ReturnType<typeof getConfig>): string | null {
  if (!config.user) return "EMAIL_ME_USER is not set";
  if (!config.pass) return "EMAIL_ME_PASS is not set";
  if (!config.to) return "EMAIL_ME_TO is not set";
  return null;
}

async function sendEmail(
  subject: string,
  body: string,
  toOverride?: string,
): Promise<SendResult> {
  const config = getConfig();
  const error = validateConfig(config);
  if (error) throw new Error(`Configuration error: ${error}`);

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  const prefixedSubject = `${config.subjectPrefix} ${subject}`;
  const to = toOverride || config.to;

  const info = await transporter.sendMail({
    from: config.from,
    to,
    subject: prefixedSubject,
    text: body,
  });

  return {
    messageId: info.messageId,
    accepted: (info.accepted as string[]) || [],
    rejected: (info.rejected as string[]) || [],
  };
}

export default function (pi: ExtensionAPI) {
  // ---- Tool: send_email ----
  pi.registerTool({
    name: "send_email",
    label: "Send Email",
    description:
      "Send an email notification via SMTP. Use this to notify the user about important events, " +
      "long-running task completions, errors that need attention, or when the user explicitly " +
      "asks to send an email. Keep messages concise but informative.",
    promptSnippet: "Send an email via SMTP",
    promptGuidelines: [
      "Use send_email when the user asks to notify them, send an email, or when a significant task completes.",
      "Use send_email sparingly — only for noteworthy events, not routine progress updates.",
      "Include relevant details in the body: what happened, any errors, next steps, and links if applicable.",
    ],
    parameters: Type.Object({
      subject: Type.String({
        description:
          "Email subject line (a prefix from EMAIL_ME_SUBJECT_PREFIX will be added automatically)",
      }),
      body: Type.String({
        description:
          "Email body (plain text). Include relevant context: what task completed, key results, errors if any, and suggested next steps.",
      }),
      to: Type.Optional(
        Type.String({
          description:
            "Override recipient email address. Defaults to EMAIL_ME_TO.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await sendEmail(params.subject, params.body, params.to);
      return {
        content: [
          {
            type: "text",
            text: `Email sent successfully.\nMessage ID: ${result.messageId}\nAccepted: ${result.accepted.join(", ") || "none"}\nRejected: ${result.rejected.join(", ") || "none"}`,
          },
        ],
        details: result,
      };
    },
  });

  // ---- Command: /email ----
  pi.registerCommand("email", {
    description: "Send an email. Usage: /email <subject> | <body>",
    handler: async (args, ctx) => {
      if (!args || !args.includes("|")) {
        ctx.ui.notify(
          'Usage: /email <subject> | <body>\nExample: /email Build done | All tests passed, ready to merge.',
          "error",
        );
        return;
      }

      const config = getConfig();
      const configError = validateConfig(config);
      if (configError) {
        ctx.ui.notify(
          `Email not configured. Missing: ${configError}\n\nSet the required environment variables:\n  EMAIL_ME_USER, EMAIL_ME_PASS, EMAIL_ME_TO`,
          "error",
        );
        return;
      }

      const sepIndex = args.indexOf("|");
      const subject = args.slice(0, sepIndex).trim();
      const body = args.slice(sepIndex + 1).trim();

      if (!subject || !body) {
        ctx.ui.notify("Both subject and body are required.", "error");
        return;
      }

      try {
        const result = await sendEmail(subject, body);
        ctx.ui.notify(
          `Email sent! ID: ${result.messageId}`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Failed to send: ${err.message}`, "error");
      }
    },
  });

  // ---- Startup: check config ----
  pi.on("session_start", async (_event, ctx) => {
    const configError = validateConfig(getConfig());
    if (configError) {
      ctx.ui.notify(
        `email_me: not configured (${configError}). Copy .env.template → .env and fill in your credentials.`,
        "warn",
      );
    } else {
      ctx.ui.notify(
        `email_me: ready (${getConfig().user} → ${getConfig().to})`,
        "info",
      );
    }
  });
}
