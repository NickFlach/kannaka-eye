#!/bin/bash
# run-eye.sh — launcher for the kannaka-eye glyph emitter on Oracle.
#
# Serves the SGA glyph HTTP/WebGL app AND connects the attention-bridge, which
# publishes a glyph to KANNAKA.attention.eye on every /api/process and
# /api/radio. That subject is NOT in anon's NATS allow-list, so we authenticate
# as kannaka_internal (creds from /home/opc/.kannaka-nats.env). KANNAKA_BIN
# points at the native classifier so the eye's dominant_class agrees with how
# kannaka-memory classifies a memory (gravity alignment).
set -u
cd /home/opc/kannaka-eye

# NATS creds (NATS_USER / NATS_PASSWORD) for the kannaka_internal account.
[ -f /home/opc/.kannaka-nats.env ] && { set -a; . /home/opc/.kannaka-nats.env; set +a; }

export NATS_URL="${NATS_URL:-${KANNAKA_NATS_URL:-nats://swarm.ninja-portal.com:4222}}"
export KANNAKA_EYE_HEMISPHERE="${KANNAKA_EYE_HEMISPHERE:-right}"
export KANNAKA_BIN="${KANNAKA_BIN:-/home/opc/.local/bin/kannaka}"
export RADIO_URL="${RADIO_URL:-http://localhost:8888}"
export EYE_PORT="${EYE_PORT:-3335}"   # 3333 = local default, 3334 = observatory

exec node server.js --port "$EYE_PORT"
