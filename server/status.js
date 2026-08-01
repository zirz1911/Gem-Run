const statusNames = {
  submitted: "submitted", pending: "submitted", queued: "submitted",
  running: "running", processing: "running", in_progress: "running",
  success: "success", succeeded: "success", complete: "success", completed: "success", done: "success",
  failed: "failed", failure: "failed", error: "failed",
  timeout: "timeout", timed_out: "timeout"
};

export function normalizeRemoteStatus(payload) {
  const value = payload?.status ?? payload?.data?.status ?? payload?.data?.state ?? payload?.state;
  return statusNames[String(value || "").toLowerCase()] ?? "submitted";
}
