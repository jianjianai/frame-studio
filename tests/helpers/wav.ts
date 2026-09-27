/** Owned PCM fixture for file import/decoding tests, independent of demo music. */
export function testWav(duration = 2, sampleRate = 48000): Buffer {
  const frames = Math.round(duration * sampleRate);
  const output = Buffer.alloc(44 + frames * 4);
  output.write("RIFF");
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(2, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 4, 28);
  output.writeUInt16LE(4, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(
      Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 6000,
    );
    output.writeInt16LE(value, 44 + i * 4);
    output.writeInt16LE(value, 46 + i * 4);
  }
  return output;
}
