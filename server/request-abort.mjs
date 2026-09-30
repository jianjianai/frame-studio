/** Abort transient reads on client disconnect; durable operations own cancellation. */
export function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.raw.off("aborted", abort);
    res.raw.off("close", closed);
    res.raw.off("finish", cleanup);
  };
  const abort = () => {
    controller.abort(new DOMException("Client disconnected", "AbortError"));
    cleanup();
  };
  const closed = () => {
    if (!res.raw.writableEnded) abort();
    else cleanup();
  };
  req.raw.once("aborted", abort);
  res.raw.once("close", closed);
  res.raw.once("finish", cleanup);
  if (req.raw.aborted || res.raw.destroyed) abort();
  return controller.signal;
}
