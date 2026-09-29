// Historical turns use bounded reads, not one permanent WebSocket subscription per turn.
export function loadTaskEvents({ tasks, cache, call, subscribe, onChange, onError, concurrency = 4 }) {
  let cancelled = false;
  const stops = [];
  const ids = new Set(tasks.map((task) => task.id));
  for (const id of Object.keys(cache)) if (!ids.has(id)) delete cache[id];
  const publish = () => {
    if (!cancelled) onChange(Object.fromEntries(Object.entries(cache).map(([id, value]) => [id, [...value.rows]])));
  };
  const merge = (entry, events) => {
    const rows = new Map(entry.rows.map((row) => [row.id, row]));
    for (const row of events) rows.set(row.id, row);
    entry.rows = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
    entry.after = Number(entry.rows.at(-1)?.id || 0);
    publish();
  };
  const history = [];
  for (const task of tasks) {
    const entry = (cache[task.id] ||= { after: 0, rows: [], loadedState: null });
    if (["running", "cancelling", "publishing"].includes(task.state)) {
      entry.loadedState = null;
      stops.push(subscribe("task_get", { id: task.id, after: entry.after }, ({ result, error }) => {
        if (cancelled) return;
        if (error) { onError(error); return; }
        merge(entry, result.events || []);
      }));
    } else if (task.state !== "queued" && entry.loadedState !== task.state) {
      history.push(task);
    }
  }
  publish();
  const worker = async () => {
    while (!cancelled && history.length) {
      const task = history.shift(), entry = cache[task.id];
      try {
        while (!cancelled) {
          const result = await call("task_get", { id: task.id, after: entry.after });
          if (cancelled) return;
          const events = result.events || [];
          merge(entry, events);
          if (events.length < 100) { entry.loadedState = task.state; break; }
        }
      } catch (error) { if (!cancelled) onError(error.message || String(error)); }
    }
  };
  const workers = Math.min(concurrency, history.length);
  for (let i = 0; i < workers; i++) void worker();
  return () => { cancelled = true; stops.forEach((stop) => stop()); };
}
