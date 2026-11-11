// Runtime fault switches for Area D. They are reachable only through the internal-key endpoint, so
// they are not part of the public API, and they are in-memory, so a restart clears them.
//
// The three modes map to the three failures the brief asks for:
//   lost_reply   — the write commits, then the connection is destroyed before the response arrives.
//   slow_reply_ms— the write commits, then the response is delayed past the client timeout.
//   outage_ms    — every request fails with 503 for a time window, before any write happens.
//
// lost_reply and slow_reply are one-shot: the first request consumes the switch, so the client's
// retry sees a normal service and can prove that the retry is idempotent. The outage is time-window
// based because that is what an outage is; retries (or the reconciler) recover when it ends.
const state = {
  lost_reply: false,
  slow_reply_ms: 0,
  outage_until: 0,
  outage_ms: 0,
};

function snapshot(now = Date.now()) {
  return {
    lost_reply: state.lost_reply,
    slow_reply_ms: state.slow_reply_ms,
    outage_ms: state.outage_ms,
    outage_remaining_ms: Math.max(0, state.outage_until - now),
  };
}

function set(next = {}) {
  if (typeof next.lost_reply === "boolean") state.lost_reply = next.lost_reply;
  if (Number.isFinite(next.slow_reply_ms)) state.slow_reply_ms = Math.max(0, next.slow_reply_ms);
  if (Number.isFinite(next.outage_ms)) {
    state.outage_ms = Math.max(0, next.outage_ms);
    state.outage_until = Date.now() + state.outage_ms;
  }
  return snapshot();
}

function reset() {
  state.lost_reply = false;
  state.slow_reply_ms = 0;
  state.outage_until = 0;
  state.outage_ms = 0;
  return snapshot();
}

function outageActive(now = Date.now()) {
  return now < state.outage_until;
}

function consumeLostReply() {
  if (!state.lost_reply) return false;
  state.lost_reply = false;
  return true;
}

function takeSlowReplyMs() {
  const ms = state.slow_reply_ms;
  state.slow_reply_ms = 0;
  return ms;
}

module.exports = {
  snapshot,
  set,
  reset,
  outageActive,
  consumeLostReply,
  takeSlowReplyMs,
};
