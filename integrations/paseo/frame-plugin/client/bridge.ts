import { FrameOperationSchema, type FrameOperation } from "../shared/bridge";

export interface FrameClientBridge {
  request: (op: FrameOperation, payload: unknown) => Promise<unknown>;
  subscribe: (listener: (event: string, payload: unknown) => void) => () => void;
}
export function getFrameClientBridge(): FrameClientBridge {
  const value: unknown = Reflect.get(globalThis, "__PASEO_FRAME_BRIDGE__");
  if (typeof value !== "object" || value === null)
    throw new Error("The Frame work is not connected.");
  const request: unknown = Reflect.get(value, "request");
  const subscribe: unknown = Reflect.get(value, "subscribe");
  if (typeof request !== "function" || typeof subscribe !== "function") {
    throw new Error("The Frame work connection is invalid.");
  }
  return {
    request(op, payload) {
      FrameOperationSchema.parse(op);
      return Promise.resolve(request(op, payload));
    },
    subscribe(listener) {
      const remove: unknown = subscribe(listener);
      if (typeof remove !== "function")
        throw new Error("The Frame context subscription is invalid.");
      return () => {
        remove();
      };
    },
  };
}
