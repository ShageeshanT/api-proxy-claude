#!/bin/sh
# Restore Claude Code credentials from environment variables so the CLI can
# authenticate without an interactive `claude auth login`.
#
# Provide EITHER:
#   CLAUDE_CREDENTIALS_JSON  — full contents of ~/.claude/.credentials.json
# OR:
#   CLAUDE_CODE_OAUTH_TOKEN  — just the access token (the CLI reads this env
#                              var directly; no file needed)
#
# Also required at runtime:
#   PROXY_API_KEY            — bearer token clients must send to hit /v1
#   PORT                     — injected by Railway; defaults to 3456 locally
set -e

CRED_DIR="${HOME:-/home/claude}/.claude"
CRED_FILE="$CRED_DIR/.credentials.json"

if [ -n "$CLAUDE_CREDENTIALS_JSON" ]; then
  mkdir -p "$CRED_DIR"
  printf '%s' "$CLAUDE_CREDENTIALS_JSON" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  echo "[entrypoint] Wrote Claude credentials to $CRED_FILE"
elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo "[entrypoint] Using CLAUDE_CODE_OAUTH_TOKEN env var"
else
  echo "[entrypoint] WARNING: no Claude credentials provided." >&2
  echo "[entrypoint] Set CLAUDE_CREDENTIALS_JSON or CLAUDE_CODE_OAUTH_TOKEN." >&2
fi

if [ -z "$PROXY_API_KEY" ]; then
  echo "[entrypoint] WARNING: PROXY_API_KEY is unset — /v1 endpoints are OPEN." >&2
fi

exec "$@"
