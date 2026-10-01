/** Session attachment is independent of source updates: the persistent player owns revision swaps.
 * Transport and timers are injected so reconnect and stale-result behavior can be verified.
 */
export function createPreviewSessionController({
  loadLive,
  loadStable,
  publish,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let input = null,
    target = "",
    attachedTarget = "",
    generation = 0,
    disposed = false,
    timer,
    attempts = 0;
  let state = {
    preview: null,
    stage: "正在获取作品…",
    error: "",
    status: "starting",
  };
  const emit = (patch) => {
    state = { ...state, ...patch };
    if (!disposed) publish(state);
  };
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const current = (version) =>
    !disposed && generation === version && !input?.blocked;
  const later = (delay) => {
    clear();
    if (!disposed && !input?.blocked)
      timer = schedule(() => {
        timer = undefined;
        void attach();
      }, delay);
  };
  const renewIn = (preview) => {
    const expires = Date.parse(preview?.expires || "");
    return Number.isFinite(expires)
      ? Math.max(1000, Math.min(20 * 60000, expires - now() - 120000))
      : 20 * 60000;
  };
  async function attach() {
    if (!input?.workId || input.blocked || disposed) return;
    clear();
    const version = ++generation,
      snapshot = input;
    const live = snapshot.mode === "live",
      started = now();
    if (!state.preview)
      emit({ stage: live ? "正在准备实时预览…" : "正在获取作品…" });
    try {
      if (!live && !snapshot.latest) return;
      const link = live
        ? await loadLive({
            id: snapshot.workId,
            ...(snapshot.taskId ? { task: snapshot.taskId } : {}),
            ...(snapshot.source ? { source: snapshot.source } : {}),
            ...(snapshot.paseoAgent ? { paseoAgent: snapshot.paseoAgent } : {}),
          })
        : await loadStable(snapshot.latest);
      if (!current(version)) return;
      if (
        !link ||
        typeof link.url !== "string" ||
        (live && typeof link.sessionId !== "string")
      )
        throw Error("预览会话响应无效");
      const same = live
        ? state.preview?.sessionId === link.sessionId
        : state.preview?.id === snapshot.latest.id;
      const preview = live
        ? {
            ...link,
            id: link.sessionId,
            live: true,
            requestedAt: started,
            observedRevision: same
              ? state.preview?.observedRevision || null
              : null,
            requestedTask: snapshot.taskId || null,
          }
        : {
            ...link,
            id: snapshot.latest.id,
            live: false,
            sourceCommit: snapshot.latest.source_commit || null,
            fingerprint: snapshot.latest.fingerprint || null,
            previewVersion: snapshot.latest.result?.previewVersion || 0,
            requestedAt: started,
          };
      if (live && state.preview && !same && link.state !== "ready") {
        emit({
          status: link.state === "error" ? "error" : "updating",
          error:
            link.state === "error"
              ? "新草稿尚无法预览，继续显示上次可用画面"
              : "",
        });
        later(link.state === "error" ? 5000 : 1500);
        return;
      }
      attempts = 0;
      attachedTarget = target;
      emit({
        preview,
        error:
          live && link.state === "error"
            ? state.error || "当前修改无法预览，继续显示上次可用画面"
            : "",
        status:
          same && state.status === "ready"
            ? "ready"
            : live
              ? link.state || "starting"
              : "ready",
        ...(!same ? { stage: "正在下载播放器…" } : {}),
      });
      later(renewIn(preview));
    } catch (error) {
      if (!current(version)) return;
      const message = error?.message || String(error);
      emit({
        error: message,
        status: "reconnecting",
        ...(!state.preview ? { stage: "" } : {}),
      });
      // Retain a functioning live player on transient disconnection. Only use a published
      // fallback if the requested source has never produced a live player.
      if (
        live &&
        snapshot.latest &&
        !state.preview?.live &&
        state.preview?.id !== snapshot.latest.id
      ) {
        try {
          const link = await loadStable(snapshot.latest);
          if (!current(version)) return;
          emit({
            preview: {
              ...link,
              id: snapshot.latest.id,
              live: false,
              fallback: true,
              sourceCommit: snapshot.latest.source_commit || null,
              previewVersion: snapshot.latest.result?.previewVersion || 0,
              requestedAt: started,
            },
            stage:
              state.preview?.id === snapshot.latest.id ? "" : "正在下载播放器…",
          });
        } catch {
          /* The attachment error remains visible; no full build is submitted. */
        }
      }
      if (live && current(version))
        later(Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4)));
    }
  }
  return {
    update(next) {
      if (disposed) return;
      const key = [
        next.workId,
        next.mode || "immutable",
        next.taskId || "",
        next.source || "",
        next.paseoAgent || "",
        next.mode === "live" ? "" : next.latest?.id || "",
      ].join(":");
      const changed = target !== key,
        wasBlocked = input?.blocked;
      const workChanged = input && input.workId !== next.workId;
      input = next;
      if (workChanged)
        emit({
          preview: null,
          stage: "正在获取作品…",
          error: "",
          status: "starting",
        });
      if (changed || next.blocked !== wasBlocked) {
        target = key;
        ++generation;
        clear();
        attempts = 0;
        if (!next.blocked) {
          if (
            !changed &&
            attachedTarget === target &&
            state.preview &&
            !state.error
          )
            later(renewIn(state.preview));
          else void attach();
        }
      }
    },
    retry() {
      if (!disposed && !input?.blocked) {
        attempts = 0;
        void attach();
      }
    },
    receive(message) {
      if (!state.preview?.live || disposed) return;
      const status = message.state;
      emit({
        status,
        ...(status === "ready" && message.sourceRevision
          ? {
              preview: {
                ...state.preview,
                sourceRevision: message.sourceRevision,
                observedRevision: message.sourceRevision,
              },
            }
          : {}),
        error:
          status === "error"
            ? message.error || "当前修改无法预览，继续显示上次可用画面"
            : "",
        stage: status === "ready" || status === "error" ? "" : state.stage,
      });
      if (status === "reconnecting")
        later(Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4)));
      if (status === "ready") {
        attempts = 0;
        later(renewIn(state.preview));
      }
    },
    setStage(stage) {
      if (!disposed) emit({ stage });
    },
    getState() {
      return state;
    },
    dispose() {
      disposed = true;
      ++generation;
      clear();
    },
  };
}

/** A draft must belong to the open work; only a running authoring task has a workspace. */
export function activePreviewTask(tasks, workId) {
  return (tasks || [])
    .filter(
      (task) =>
        task.kind === "agent" &&
        task.state === "running" &&
        (!task.work || task.work === workId) &&
        (!task.work_id || task.work_id === workId),
    )
    .sort((a, b) =>
      String(
        b.started_at || b.started || b.created_at || b.created || "",
      ).localeCompare(
        String(a.started_at || a.started || a.created_at || a.created || ""),
      ),
    )[0]?.id;
}
