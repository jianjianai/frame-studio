import { describe, expect, it, vi } from 'vitest';
import { createAudio } from '../../r2/music';

interface FakeNode {
  connected: boolean;
  buffer?: { length: number; duration: number };
  gain: { value: number; setValueAtTime(): void; linearRampToValueAtTime(): void };
  pan: { value: number };
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect(): void;
  disconnect(): void;
  stop: ReturnType<typeof vi.fn>;
  start(when: number, offset?: number, duration?: number): void;
}

function fixture() {
  const nodes: FakeNode[] = [];
  const starts: { node: FakeNode; when: number; offset: number; duration?: number }[] = [];
  let failNextStart = false;
  function node(): FakeNode {
    const result = {
      connected: false,
      buffer: undefined as { length: number; duration: number } | undefined,
      gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} },
      pan: { value: 0 }, playbackRate: { value: 1 },
      onended: null as null | (() => void),
      connect() { result.connected = true; },
      disconnect() { result.connected = false; },
      stop: vi.fn(),
      start(when: number, offset = 0, duration?: number) {
        if (failNextStart) { failNextStart = false; throw new Error('start failed'); }
        starts.push({ node: result, when, offset, duration });
      },
    };
    nodes.push(result);
    return result;
  }
  const context = {
    currentTime: 0, sampleRate: 8000,
    createGain: node, createStereoPanner: node, createBufferSource: node,
    createBuffer(_channels: number, length: number, sampleRate: number) {
      const data = new Float32Array(length);
      return { length, duration: length / sampleRate, getChannelData: () => data };
    },
  };
  return {
    context, nodes, starts,
    failStart() { failNextStart = true; },
    options: { trackId: 'music', context: context as unknown as BaseAudioContext, destination: {} as AudioNode, when: 0, offset: 0, duration: 153.6, rate: 1 },
  };
}

describe('R2 bounded native audio scheduling', () => {
  it('keeps startup bounded and restores overlapping tails on a double-speed seek', () => {
    const f = fixture();
    const graph = createAudio({ ...f.options, offset: 1, rate: 2 });
    const notes = f.starts.filter(s => s.node.buffer!.length > 1);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThan(100);
    expect(notes.some(s => s.offset > 0 && s.when === 0)).toBe(true);
    expect(notes.every(s => s.when < 2)).toBe(true);
    graph.dispose(); graph.dispose();
    expect(f.nodes.every(n => !n.connected)).toBe(true);
  });

  it('disposes a cancelled wake so old playback cannot create ghost notes', () => {
    const f = fixture();
    const graph = createAudio(f.options);
    const wake = f.starts.find(s => s.node.buffer!.length === 1)!;
    const callback = wake.node.onended!;
    const count = f.starts.length;
    graph.dispose();
    f.context.currentTime = 10;
    callback();
    expect(f.starts).toHaveLength(count);
    expect(wake.node.stop).toHaveBeenCalledOnce();
    expect(f.nodes.every(n => !n.connected)).toBe(true);
  });

  it('reports an exhausted lookahead and releases the entire graph', () => {
    const f = fixture(), onError = vi.fn();
    createAudio({ ...f.options, onError });
    f.context.currentTime = 10;
    f.starts.find(s => s.node.buffer!.length === 1)!.node.onended!();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toContain('配乐缓冲不足');
    expect(f.nodes.every(n => !n.connected)).toBe(true);
  });

  it('cleans up native sources if initial scheduling fails', () => {
    const f = fixture(); f.failStart();
    expect(() => createAudio(f.options)).toThrow('start failed');
    expect(f.nodes.every(n => !n.connected)).toBe(true);
    expect(f.nodes.some(n => n.stop.mock.calls.length > 0)).toBe(true);
  });
});
