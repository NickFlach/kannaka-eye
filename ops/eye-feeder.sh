#!/bin/bash
# eye-feeder.sh — keep the attention-as-gravity loop fed.
#
# Hits /api/radio, which now builds a glyph from the radio's live audio features
# and PUBLISHES it to KANNAKA.attention.eye (the eye "seeing" what Kannaka
# hears). The glyph's dominant Fano line then pulls same-line memories into the
# attention beam. Run from cron every minute.
set -u
PORT="${EYE_PORT:-3335}"
curl -fsS "http://localhost:${PORT}/api/radio" >/dev/null 2>&1 || true
