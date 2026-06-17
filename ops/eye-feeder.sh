#!/bin/bash
# eye-feeder.sh — keep the attention-as-gravity loop fed.
#
# Pulls the radio's current track from the eye's /api/radio, then POSTs it to
# /api/process so the eye actually PUBLISHES a glyph to KANNAKA.attention.eye
# (/api/radio renders but does not publish; /api/process does). The glyph's
# dominant Fano line then pulls same-line memories into the attention beam.
# Run from cron every minute.
set -u
PORT="${EYE_PORT:-3335}"

TRACK="$(curl -fsS "http://localhost:${PORT}/api/radio" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print((str(d.get("track","")) + " " + str(d.get("album",""))).strip())
except Exception:
    pass
' 2>/dev/null)"

[ -z "$TRACK" ] && exit 0

BODY="$(python3 -c 'import json,sys; print(json.dumps({"data": sys.argv[1], "type": "text"}))' "$TRACK")"
curl -fsS -X POST "http://localhost:${PORT}/api/process" \
  -H 'content-type: application/json' --data "$BODY" >/dev/null 2>&1 || true
