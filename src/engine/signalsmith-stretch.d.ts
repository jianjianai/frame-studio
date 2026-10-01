declare module "signalsmith-stretch" {
  const create: (
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ) => Promise<import("./signalsmith-audio").SignalsmithNode>;
  export default create;
}
