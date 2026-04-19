/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-opus-4-6";
    let isComplete = false;
    let hasEmittedText = false;
    let toolCallIndex = 0;
    let inToolBlock = false;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "claude-haiku-4",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle GET /
 *
 * Simple landing page so the server doesn't 404 when opened in a browser.
 */
export function handleRoot(_req: Request, res: Response): void {
  const host = _req.headers.host || "localhost:3456";
  const base = `http://${host}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Claude Max API Proxy</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: .2rem; }
  .sub { color: #888; margin-top: 0; }
  .ok { color: #0a7f2e; font-weight: 600; }
  code, pre { background: rgba(127,127,127,.12); padding: .1rem .35rem; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { padding: .75rem 1rem; overflow-x: auto; }
  table { border-collapse: collapse; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .35rem .75rem .35rem 0; border-bottom: 1px solid rgba(127,127,127,.2); }
  a { color: #2266dd; }
</style>
</head>
<body>
  <h1>Claude Max API Proxy</h1>
  <p class="sub"><span class="ok">&#x25CF; running</span> &middot; OpenAI-compatible proxy for the Claude Code CLI</p>

  <h2>Endpoints</h2>
  <table>
    <tr><th>GET</th>  <td><a href="/health">/health</a></td>         <td>health check</td></tr>
    <tr><th>GET</th>  <td><a href="/v1/models">/v1/models</a></td>   <td>list models</td></tr>
    <tr><th>POST</th> <td><code>/v1/chat/completions</code></td>    <td>chat (streaming &amp; non-streaming)</td></tr>
  </table>

  <h2>Default model</h2>
  <p><code>claude-opus-4-6</code> (Claude Opus 4.6)</p>

  <h2>Quick test</h2>
  <pre>curl -X POST ${base}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello!"}]}'</pre>

  <p>Try the built-in <a href="/chat"><strong>chat UI &rarr;</strong></a>
  or point your OpenAI-compatible client at <code>${base}/v1</code>.</p>
</body>
</html>`);
}

/**
 * Handle GET /chat
 *
 * Minimal single-page chat UI that talks to /v1/chat/completions.
 * Stores the bearer token (if any) in localStorage so personal deploys work.
 */
export function handleChat(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(CHAT_HTML);
}

const CHAT_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Claude</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css" />
<script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<style>
  :root {
    color-scheme: light dark;
    --bg:        #faf9f5;
    --bg-sub:    #f0efe7;
    --panel:     #ffffff;
    --text:      #1f1e1d;
    --text-sub:  #6a655c;
    --muted:     #8f8a80;
    --border:    #e5e2d8;
    --border-soft: #eeebe1;
    --hover:     #f0efe7;
    --user-bg:   #eeebe1;
    --accent:    #c96342;
    --accent-hover: #b55734;
    --accent-soft: rgba(201,99,66,.12);
    --shadow:    0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.04);
    --shadow-lg: 0 12px 32px rgba(0,0,0,.08);
    --radius:    12px;
    --radius-lg: 20px;
    --serif: "Source Serif 4", Iowan Old Style, "Apple Garamond", Baskerville, Georgia, serif;
    --sans:  "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono:  ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:        #262624;
      --bg-sub:    #1f1e1d;
      --panel:     #30302e;
      --text:      #faf9f5;
      --text-sub:  #b5b0a5;
      --muted:     #8f8a80;
      --border:    #3a3a37;
      --border-soft: #2e2e2c;
      --hover:     #3a3a37;
      --user-bg:   #3a3a37;
      --accent:    #d97757;
      --accent-hover: #e88868;
      --accent-soft: rgba(217,119,87,.18);
      --shadow:    0 1px 2px rgba(0,0,0,.2), 0 4px 16px rgba(0,0,0,.25);
      --shadow-lg: 0 12px 32px rgba(0,0,0,.4);
    }
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    display: flex;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow: hidden;
  }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.25); border-radius: 10px; border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.45); background-clip: padding-box; border: 2px solid transparent; }

  /* ─── Sidebar ─────────────────────────────────────────── */
  aside {
    width: 260px;
    background: var(--bg-sub);
    border-right: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    transition: margin-left .25s ease;
  }
  aside.hidden { margin-left: -260px; }
  .brand {
    padding: 16px 18px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    font-size: 17px;
    letter-spacing: -.01em;
  }
  .brand .logo {
    width: 26px; height: 26px; border-radius: 7px;
    background: var(--accent);
    display: grid; place-items: center;
    color: white; font-weight: 700; font-size: 14px;
  }
  .new-chat {
    margin: 4px 12px 12px;
    padding: 10px 14px;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    font: 500 14px var(--sans);
    cursor: pointer;
    display: flex; align-items: center; gap: 8px;
    transition: background .15s ease, border-color .15s ease;
  }
  .new-chat:hover { background: var(--hover); border-color: var(--accent); }
  .new-chat svg { width: 16px; height: 16px; stroke-width: 2; }

  .chat-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 8px;
    list-style: none;
    margin: 0;
  }
  .chat-list .section-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .08em;
    padding: 12px 10px 6px;
    font-weight: 600;
  }
  .chat-list li {
    padding: 8px 10px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-sub);
    display: flex; align-items: center; gap: 8px;
    transition: background .12s ease, color .12s ease;
    position: relative;
  }
  .chat-list li:hover { background: var(--hover); color: var(--text); }
  .chat-list li.active { background: var(--accent-soft); color: var(--text); font-weight: 500; }
  .chat-list li .delete-chat {
    opacity: 0;
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 2px 4px;
    margin-left: auto;
    border-radius: 4px;
    transition: opacity .12s ease, color .12s ease, background .12s ease;
  }
  .chat-list li:hover .delete-chat { opacity: 1; }
  .chat-list li .delete-chat:hover { background: rgba(0,0,0,.08); color: var(--text); }
  @media (prefers-color-scheme: dark) { .chat-list li .delete-chat:hover { background: rgba(255,255,255,.08); } }

  .sidebar-footer {
    border-top: 1px solid var(--border-soft);
    padding: 12px;
  }
  .sidebar-footer label {
    display: block;
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .08em;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .sidebar-footer input {
    width: 100%;
    padding: 8px 10px;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    font: 13px var(--mono);
    transition: border-color .15s ease;
  }
  .sidebar-footer input:focus { outline: none; border-color: var(--accent); }

  /* ─── Main ────────────────────────────────────────────── */
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--text-sub);
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    display: inline-grid; place-items: center;
    transition: background .12s ease, color .12s ease;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }
  .icon-btn svg { width: 18px; height: 18px; stroke-width: 2; }

  .model-picker {
    position: relative;
    margin-left: 4px;
  }
  .model-picker select {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text);
    font: 500 14px var(--sans);
    padding: 6px 30px 6px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition: background .12s ease, border-color .12s ease;
  }
  .model-picker::after {
    content: "";
    position: absolute; right: 10px; top: 50%;
    width: 8px; height: 8px;
    border-right: 1.5px solid var(--text-sub);
    border-bottom: 1.5px solid var(--text-sub);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  .model-picker:hover select { background: var(--hover); }

  .topbar .spacer { flex: 1; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #3a9a5a; box-shadow: 0 0 0 3px rgba(58,154,90,.18); }

  /* ─── Messages ───────────────────────────────────────── */
  .scroller { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
  .messages {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 28px 120px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .msg { animation: fadeInUp .3s cubic-bezier(.2,.7,.3,1); }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .msg.user .bubble {
    background: var(--user-bg);
    padding: 12px 18px;
    border-radius: 18px;
    max-width: 100%;
    white-space: pre-wrap;
    word-wrap: break-word;
    display: inline-block;
  }
  .msg.user { display: flex; justify-content: flex-end; }

  .msg.assistant {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .avatar {
    width: 28px; height: 28px; border-radius: 8px;
    background: var(--accent);
    display: grid; place-items: center;
    color: white;
    font-weight: 700; font-size: 13px;
    flex-shrink: 0; margin-top: 2px;
    box-shadow: var(--shadow);
  }
  .msg.assistant .body {
    font-family: var(--serif);
    font-size: 16.5px;
    line-height: 1.7;
    color: var(--text);
    flex: 1;
    min-width: 0;
  }
  .msg.assistant .body > *:first-child { margin-top: 0; }
  .msg.assistant .body > *:last-child { margin-bottom: 0; }
  .msg.assistant .body p { margin: 0 0 .85em; }
  .msg.assistant .body h1,
  .msg.assistant .body h2,
  .msg.assistant .body h3,
  .msg.assistant .body h4 {
    font-family: var(--sans);
    font-weight: 600;
    letter-spacing: -.01em;
    margin: 1.4em 0 .5em;
    line-height: 1.3;
  }
  .msg.assistant .body h1 { font-size: 1.5em; }
  .msg.assistant .body h2 { font-size: 1.25em; }
  .msg.assistant .body h3 { font-size: 1.1em; }
  .msg.assistant .body ul, .msg.assistant .body ol { padding-left: 1.5em; margin: 0 0 .85em; }
  .msg.assistant .body li { margin-bottom: .25em; }
  .msg.assistant .body li > p { margin: 0 0 .3em; }
  .msg.assistant .body a { color: var(--accent); text-underline-offset: 2px; }
  .msg.assistant .body a:hover { color: var(--accent-hover); }
  .msg.assistant .body blockquote {
    border-left: 3px solid var(--border);
    padding: .2em 1em;
    margin: 0 0 .85em;
    color: var(--text-sub);
    font-style: italic;
  }
  .msg.assistant .body hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
  .msg.assistant .body table { border-collapse: collapse; margin: 0 0 .85em; font-family: var(--sans); font-size: 14px; }
  .msg.assistant .body th, .msg.assistant .body td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
  .msg.assistant .body th { background: var(--bg-sub); font-weight: 600; }

  .msg .body code {
    font-family: var(--mono);
    font-size: .88em;
    background: var(--bg-sub);
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid var(--border-soft);
  }
  .code-block {
    margin: .85em 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: #1e1e1e;
    font-family: var(--sans);
  }
  .code-block-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px 6px 14px;
    background: #282c34;
    color: #abb2bf;
    font-size: 12px;
    border-bottom: 1px solid rgba(255,255,255,.05);
  }
  .code-block-header .lang { text-transform: lowercase; letter-spacing: .02em; }
  .code-block-header .copy-btn {
    background: transparent;
    border: none;
    color: #abb2bf;
    font: 12px var(--sans);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 5px;
    display: flex; align-items: center; gap: 4px;
    transition: background .12s ease, color .12s ease;
  }
  .code-block-header .copy-btn:hover { background: rgba(255,255,255,.08); color: #fff; }
  .code-block-header .copy-btn svg { width: 13px; height: 13px; }
  .code-block pre {
    margin: 0;
    padding: 14px 16px;
    overflow-x: auto;
    background: #282c34;
  }
  .code-block pre code {
    background: transparent;
    border: none;
    padding: 0;
    font-family: var(--mono);
    font-size: 13.5px;
    line-height: 1.55;
    color: #abb2bf;
  }

  .msg.error .body {
    background: rgba(201,66,66,.08);
    border: 1px solid rgba(201,66,66,.3);
    color: #c94242;
    padding: 12px 16px;
    border-radius: 10px;
    font-family: var(--sans);
    font-size: 14px;
  }

  .msg-actions {
    margin-top: 8px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity .15s ease;
  }
  .msg.assistant:hover .msg-actions,
  .msg.assistant:focus-within .msg-actions { opacity: 1; }
  .msg-actions button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-sub);
    font: 12px var(--sans);
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    display: flex; align-items: center; gap: 4px;
    transition: background .12s ease, color .12s ease;
  }
  .msg-actions button:hover { background: var(--hover); color: var(--text); }
  .msg-actions button svg { width: 13px; height: 13px; }

  /* Thinking indicator */
  .thinking {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    padding: 2px 0;
  }
  .thinking span {
    width: 6px; height: 6px;
    background: var(--text-sub);
    border-radius: 50%;
    animation: bounce 1.3s infinite ease-in-out;
  }
  .thinking span:nth-child(2) { animation-delay: .15s; }
  .thinking span:nth-child(3) { animation-delay: .3s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: scale(.5); opacity: .4; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* Empty state */
  .empty-state {
    max-width: 720px;
    margin: auto;
    padding: 60px 28px;
    text-align: center;
  }
  .empty-state h2 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 32px;
    letter-spacing: -.02em;
    margin: 0 0 12px;
    color: var(--text);
  }
  .empty-state h2 .accent { color: var(--accent); }
  .empty-state p { color: var(--text-sub); margin: 0 0 28px; }
  .suggestions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    text-align: left;
  }
  .suggestion {
    padding: 14px 16px;
    border: 1px solid var(--border);
    background: var(--panel);
    border-radius: 12px;
    cursor: pointer;
    font-size: 14px;
    color: var(--text);
    transition: all .15s ease;
  }
  .suggestion:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
    box-shadow: var(--shadow);
  }
  .suggestion .title { font-weight: 500; margin-bottom: 2px; }
  .suggestion .desc { color: var(--muted); font-size: 13px; }

  /* ─── Composer ───────────────────────────────────────── */
  .composer-wrap {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 16px 20px 20px;
    background: linear-gradient(to bottom, transparent, var(--bg) 30%);
    pointer-events: none;
  }
  .composer {
    max-width: 760px;
    margin: 0 auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    padding: 8px 8px 8px 18px;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    pointer-events: auto;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .composer:focus-within {
    border-color: var(--accent);
    box-shadow: var(--shadow-lg), 0 0 0 4px var(--accent-soft);
  }
  .composer textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font: 15px/1.5 var(--sans);
    resize: none;
    max-height: 220px;
    min-height: 28px;
    padding: 10px 0;
    outline: none;
  }
  .composer textarea::placeholder { color: var(--muted); }
  .send-btn {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: var(--accent);
    color: white;
    border: none;
    cursor: pointer;
    display: grid; place-items: center;
    flex-shrink: 0;
    transition: background .15s ease, transform .1s ease, opacity .15s ease;
  }
  .send-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .send-btn:active:not(:disabled) { transform: scale(.92); }
  .send-btn:disabled { opacity: .3; cursor: not-allowed; }
  .send-btn svg { width: 18px; height: 18px; stroke-width: 2.5; }
  .footer-hint {
    max-width: 760px;
    margin: 8px auto 0;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }

  /* Mobile */
  @media (max-width: 720px) {
    aside { position: absolute; z-index: 10; height: 100%; box-shadow: var(--shadow-lg); }
    aside.hidden { margin-left: -260px; }
    .messages { padding: 20px 16px 120px; }
    .composer-wrap { padding: 12px; }
    .topbar { padding: 10px 12px; }
  }
</style>
</head>
<body>

<aside id="sidebar">
  <div class="brand">
    <div class="logo">C</div>
    <span>Claude</span>
  </div>
  <button class="new-chat" id="newChat">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
    New chat
  </button>
  <ul class="chat-list" id="chatList"></ul>
  <div class="sidebar-footer">
    <label for="apiKey">Proxy API Key</label>
    <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false" />
  </div>
</aside>

<main>
  <div class="topbar">
    <button class="icon-btn" id="toggleSidebar" title="Toggle sidebar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>
    <div class="model-picker">
      <select id="model" title="Model"></select>
    </div>
    <span class="spacer"></span>
    <span class="status-dot" title="Connected"></span>
  </div>

  <div class="scroller" id="scroller">
    <div class="messages" id="messages"></div>
  </div>

  <div class="composer-wrap">
    <form class="composer" id="composer">
      <textarea id="input" placeholder="Message Claude..." rows="1" autofocus></textarea>
      <button class="send-btn" id="send" type="submit" disabled aria-label="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
    </form>
    <div class="footer-hint">Claude can make mistakes. Verify important info.</div>
  </div>
</main>

<script>
(() => {
  // ─── Config ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const LS = {
    apiKey: "claude-proxy.apiKey",
    model:  "claude-proxy.model",
    chats:  "claude-proxy.chats",
    active: "claude-proxy.active",
    sidebar:"claude-proxy.sidebar",
  };

  // ─── Markdown / highlight setup ───────────────────────
  if (window.marked) {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function(code, lang) {
        if (window.hljs) {
          try {
            if (lang && hljs.getLanguage(lang)) {
              return hljs.highlight(code, { language: lang }).value;
            }
            return hljs.highlightAuto(code).value;
          } catch { return code; }
        }
        return code;
      },
    });
  }
  function renderMarkdown(text) {
    if (!window.marked) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }
    try { return marked.parse(text); } catch { return escapeHtml(text); }
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    }[c]));
  }

  // ─── State / storage ──────────────────────────────────
  let chats = {};       // { id: { id, title, messages: [{role, content}], updated } }
  let activeId = null;
  let busy = false;
  let abortCtrl = null;

  function loadState() {
    try { chats = JSON.parse(localStorage.getItem(LS.chats) || "{}"); } catch { chats = {}; }
    activeId = localStorage.getItem(LS.active) || null;
    if (activeId && !chats[activeId]) activeId = null;
  }
  function saveState() {
    localStorage.setItem(LS.chats, JSON.stringify(chats));
    if (activeId) localStorage.setItem(LS.active, activeId);
    else localStorage.removeItem(LS.active);
  }
  function newChatId() { return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
  function activeChat() {
    if (!activeId) return null;
    return chats[activeId] || null;
  }

  // ─── Elements ─────────────────────────────────────────
  const sidebar    = $("sidebar");
  const chatListEl = $("chatList");
  const messagesEl = $("messages");
  const scrollerEl = $("scroller");
  const modelEl    = $("model");
  const keyEl      = $("apiKey");
  const inputEl    = $("input");
  const sendBtn    = $("send");
  const composerEl = $("composer");

  keyEl.value = localStorage.getItem(LS.apiKey) || "";
  keyEl.addEventListener("change", () => localStorage.setItem(LS.apiKey, keyEl.value));
  keyEl.addEventListener("blur",   () => localStorage.setItem(LS.apiKey, keyEl.value));

  if (localStorage.getItem(LS.sidebar) === "hidden") sidebar.classList.add("hidden");
  $("toggleSidebar").addEventListener("click", () => {
    sidebar.classList.toggle("hidden");
    localStorage.setItem(LS.sidebar, sidebar.classList.contains("hidden") ? "hidden" : "visible");
  });

  // ─── Models ───────────────────────────────────────────
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const k = keyEl.value.trim();
    if (k) h["Authorization"] = "Bearer " + k;
    return h;
  }
  async function loadModels() {
    const fallback = ["claude-opus-4-6","claude-opus-4-7","claude-sonnet-4-6","claude-sonnet-4-5","claude-haiku-4-5"];
    let ids = fallback;
    try {
      const r = await fetch("/v1/models", { headers: authHeaders() });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.data) && data.data.length) ids = data.data.map(m => m.id);
      }
    } catch {}
    const saved = localStorage.getItem(LS.model) || "claude-opus-4-6";
    modelEl.innerHTML = ids.map(id =>
      '<option value="' + escapeHtml(id) + '"' + (id === saved ? " selected" : "") + '>' + escapeHtml(id) + '</option>'
    ).join("");
  }
  modelEl.addEventListener("change", () => localStorage.setItem(LS.model, modelEl.value));

  // ─── Sidebar rendering ───────────────────────────────
  function renderChatList() {
    const items = Object.values(chats).sort((a,b) => (b.updated||0) - (a.updated||0));
    if (!items.length) {
      chatListEl.innerHTML = '<li class="section-label" style="border:none;color:var(--muted);cursor:default">No chats yet</li>';
      chatListEl.querySelector("li").onclick = null;
      return;
    }
    chatListEl.innerHTML = items.map(c =>
      '<li data-id="' + c.id + '"' + (c.id === activeId ? ' class="active"' : '') + '>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(c.title || "New chat") + '</span>' +
        '<button class="delete-chat" title="Delete" aria-label="Delete chat">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>' +
        '</button>' +
      '</li>'
    ).join("");
    chatListEl.querySelectorAll("li[data-id]").forEach(li => {
      li.addEventListener("click", (e) => {
        if (e.target.closest(".delete-chat")) return;
        const id = li.getAttribute("data-id");
        if (id !== activeId) { activeId = id; saveState(); renderChat(); renderChatList(); }
      });
      li.querySelector(".delete-chat").addEventListener("click", (e) => {
        e.stopPropagation();
        const id = li.getAttribute("data-id");
        delete chats[id];
        if (activeId === id) activeId = null;
        saveState();
        renderChat();
        renderChatList();
      });
    });
  }

  // ─── Empty state / suggestions ───────────────────────
  const SUGGESTIONS = [
    { title: "Explain a concept", desc: "e.g. how do vector embeddings work?" },
    { title: "Help me debug",     desc: "paste an error and I'll diagnose it" },
    { title: "Draft something",   desc: "an email, a spec, a regex" },
    { title: "Summarize",         desc: "turn a long text into key points" },
  ];
  function renderEmpty() {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    messagesEl.innerHTML =
      '<div class="empty-state">' +
        '<h2><span class="accent">*</span> ' + escapeHtml(greeting) + '</h2>' +
        '<p>What would you like to explore today?</p>' +
        '<div class="suggestions">' +
          SUGGESTIONS.map(s =>
            '<div class="suggestion" data-prompt="' + escapeHtml(s.title + ": " + s.desc) + '">' +
              '<div class="title">' + escapeHtml(s.title) + '</div>' +
              '<div class="desc">' + escapeHtml(s.desc) + '</div>' +
            '</div>'
          ).join("") +
        '</div>' +
      '</div>';
    messagesEl.querySelectorAll(".suggestion").forEach(el => {
      el.addEventListener("click", () => {
        inputEl.value = el.getAttribute("data-prompt");
        autosize();
        updateSendState();
        inputEl.focus();
      });
    });
  }

  // ─── Message rendering ───────────────────────────────
  function renderChat() {
    messagesEl.innerHTML = "";
    const c = activeChat();
    if (!c || !c.messages.length) { renderEmpty(); return; }
    for (const m of c.messages) appendMessage(m.role, m.content, { animate: false });
    scrollToBottom(false);
  }

  function appendMessage(role, content, opts) {
    opts = opts || {};
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    if (!opts.animate) wrap.style.animation = "none";

    if (role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = content;
      wrap.appendChild(bubble);
    } else {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "C";
      const col = document.createElement("div");
      col.style.flex = "1";
      col.style.minWidth = "0";
      const body = document.createElement("div");
      body.className = "body";
      body.innerHTML = content ? renderMarkdown(content) : '<div class="thinking"><span></span><span></span><span></span></div>';
      col.appendChild(body);
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML =
        '<button data-action="copy" title="Copy">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '<span>Copy</span>' +
        '</button>';
      col.appendChild(actions);
      wrap.appendChild(avatar);
      wrap.appendChild(col);

      actions.querySelector('[data-action="copy"]').addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const raw = wrap.dataset.raw || body.innerText;
        navigator.clipboard.writeText(raw).then(() => {
          const span = btn.querySelector("span");
          const prev = span.textContent;
          span.textContent = "Copied";
          setTimeout(() => { span.textContent = prev; }, 1200);
        });
      });
      if (content) wrap.dataset.raw = content;
    }
    messagesEl.appendChild(wrap);
    enhanceCodeBlocks(wrap);
    return wrap;
  }

  function enhanceCodeBlocks(scope) {
    scope.querySelectorAll("pre > code").forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (pre.parentElement && pre.parentElement.classList.contains("code-block")) return;
      const langMatch = (codeEl.className || "").match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : "text";
      if (window.hljs && !codeEl.dataset.hl) {
        try {
          if (langMatch && hljs.getLanguage(lang)) hljs.highlightElement(codeEl);
          else { const r = hljs.highlightAuto(codeEl.textContent); codeEl.innerHTML = r.value; }
        } catch {}
        codeEl.dataset.hl = "1";
      }
      const block = document.createElement("div");
      block.className = "code-block";
      const header = document.createElement("div");
      header.className = "code-block-header";
      header.innerHTML =
        '<span class="lang">' + escapeHtml(lang) + '</span>' +
        '<button class="copy-btn" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '<span>Copy</span>' +
        '</button>';
      pre.parentElement.insertBefore(block, pre);
      block.appendChild(header);
      block.appendChild(pre);
      header.querySelector(".copy-btn").addEventListener("click", () => {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          const span = header.querySelector(".copy-btn span");
          const prev = span.textContent;
          span.textContent = "Copied";
          setTimeout(() => { span.textContent = prev; }, 1200);
        });
      });
    });
  }

  function isNearBottom() {
    return scrollerEl.scrollTop + scrollerEl.clientHeight >= scrollerEl.scrollHeight - 80;
  }
  function scrollToBottom(smooth) {
    scrollerEl.scrollTo({ top: scrollerEl.scrollHeight, behavior: smooth === false ? "auto" : "smooth" });
  }

  // ─── Composer ─────────────────────────────────────────
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
  }
  function updateSendState() {
    sendBtn.disabled = busy || !inputEl.value.trim();
  }
  inputEl.addEventListener("input", () => { autosize(); updateSendState(); });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composerEl.requestSubmit();
    }
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      startNewChat();
    }
  });

  function startNewChat() {
    activeId = null;
    saveState();
    renderChat();
    renderChatList();
    inputEl.focus();
  }
  $("newChat").addEventListener("click", startNewChat);

  // ─── Submit / stream ─────────────────────────────────
  composerEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = inputEl.value.trim();
    if (!text) return;

    // Create chat if none
    if (!activeId) {
      const id = newChatId();
      chats[id] = { id, title: text.slice(0, 40), messages: [], updated: Date.now() };
      activeId = id;
      messagesEl.innerHTML = "";
    }
    const c = activeChat();
    c.messages.push({ role: "user", content: text });
    c.updated = Date.now();
    if (!c.title || c.title === "New chat") c.title = text.slice(0, 40);
    saveState();
    renderChatList();

    appendMessage("user", text, { animate: true });
    inputEl.value = "";
    autosize();
    updateSendState();
    scrollToBottom();

    busy = true;
    updateSendState();
    const asstWrap = appendMessage("assistant", "", { animate: true });
    const bodyEl = asstWrap.querySelector(".body");
    let accumulated = "";
    let stickToBottom = true;
    const onScroll = () => { stickToBottom = isNearBottom(); };
    scrollerEl.addEventListener("scroll", onScroll, { passive: true });

    abortCtrl = new AbortController();
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: modelEl.value,
          messages: c.messages,
          stream: true,
        }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        let errText = "";
        try { errText = await res.text(); } catch {}
        asstWrap.classList.add("error");
        bodyEl.innerHTML = escapeHtml("HTTP " + res.status + (errText ? ": " + errText.slice(0, 500) : ""));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastRender = 0;

      const rerender = (force) => {
        const now = performance.now();
        if (!force && now - lastRender < 60) return;
        lastRender = now;
        bodyEl.innerHTML = renderMarkdown(accumulated);
        enhanceCodeBlocks(asstWrap);
        if (stickToBottom) scrollToBottom();
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              if (obj.error) throw new Error(obj.error.message || "stream error");
              const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
              if (delta && delta.content) {
                accumulated += delta.content;
                rerender(false);
              }
            } catch (err) {
              if (err instanceof SyntaxError) continue;
              throw err;
            }
          }
        }
      }

      rerender(true);
      if (accumulated) {
        asstWrap.dataset.raw = accumulated;
        c.messages.push({ role: "assistant", content: accumulated });
        c.updated = Date.now();
        saveState();
      } else {
        bodyEl.innerHTML = '<span style="color:var(--muted)">(empty response)</span>';
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        if (!accumulated) bodyEl.innerHTML = '<span style="color:var(--muted)">(stopped)</span>';
      } else {
        asstWrap.classList.add("error");
        bodyEl.innerHTML = escapeHtml("Error: " + (err && err.message ? err.message : String(err)));
      }
    } finally {
      scrollerEl.removeEventListener("scroll", onScroll);
      busy = false;
      abortCtrl = null;
      updateSendState();
      inputEl.focus();
    }
  });

  // ─── Init ─────────────────────────────────────────────
  loadState();
  loadModels();
  renderChatList();
  renderChat();
  autosize();
  updateSendState();
})();
</script>
</body>
</html>`;
