// Runtime fault switches for the demo.
//
// Area C's compensation path is only credible if a marker can actually make the remote step fail.
// The switch is in-memory (it disappears on restart) and only reachable through the internal-key
// endpoint, so it is not part of the public API.
//
// It is deliberately ONE-SHOT: the next event projection fails, then the switch clears itself. That
// isolates the injected failure to the approval step being demonstrated; the compensating action's
// own `provider.approval_reverted` event can still be projected normally afterwards. A persistent
// switch would also suppress the revert notification and make the recovery look broken.
const state = {
  notification_failure: false,
};

function getFaults() {
  return { ...state };
}

function setFaults(next) {
  if (typeof next.notification_failure === "boolean") {
    state.notification_failure = next.notification_failure;
  }
  return getFaults();
}

function resetFaults() {
  state.notification_failure = false;
  return getFaults();
}

function isNotificationFailure() {
  return state.notification_failure === true;
}

// Used by the consumer. Returns true at most once per arm, clearing the switch as a side effect.
function consumeNotificationFailure() {
  if (!state.notification_failure) return false;
  state.notification_failure = false;
  return true;
}

module.exports = {
  getFaults,
  setFaults,
  resetFaults,
  isNotificationFailure,
  consumeNotificationFailure,
};
