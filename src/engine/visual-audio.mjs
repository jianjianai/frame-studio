/** Derive linked video sound from the same authoritative clip timing as picture. */
export function visualAudioTracks(document) {
  return (document?.clips ?? [])
    .filter((c) => c.source.kind === "video" && c.audio?.enabled && !c.hidden)
    .map((c) => ({
      id: "visual:" + c.id,
      name: c.name ?? c.id,
      kind: "file",
      src: c.source.src,
      start: c.start,
      duration: c.duration,
      offset: c.offset ?? 0,
      playbackRate: c.rate ?? 1,
      phase: c.phase ?? 0,
      ...(c.loop ? { loop: c.loop } : {}),
      gain: c.audio.gain ?? 1,
      muted: c.audio.muted ?? false,
    }));
}
