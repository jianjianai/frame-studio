// The lrs.v4 frame format (log-record-sass docs/protocol.md §3), ported from the
// reference client (sub2api-jian recorderv4/wire). No I/O here, so the proxy and
// the shipping client can share it. A frame is one WebSocket binary message:
//   byte 0        type
//   bytes 1..17   record_id (raw 16-byte UUID; all-zero for connection frames)
//   bytes 17..    payload (type decides the shape)
import { createHash, randomFillSync } from "node:crypto";

export const SUBPROTOCOL = "lrs.v4";
export const HEADER_SIZE = 17;

// Client → server frame types.
export const BEGIN = 0x01;
export const REQUEST_BODY = 0x02;
export const RESPONSE_HEAD = 0x03;
export const RESPONSE_BODY = 0x04;
export const WS_MESSAGE = 0x05;
export const END = 0x06;
export const CANCEL = 0x07;
// Server → client frame types.
export const WELCOME = 0x80;
export const ACK = 0x81;
export const REJECT = 0x82;

// Headers the client must strip before shipping (names are case-insensitive);
// the server drops the same set again as defence.
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-goog-api-key"]);

/** A fresh record id as its raw 16 bytes (a random UUID v4). */
export function newRecordId() {
  const id = Buffer.allocUnsafe(16);
  randomFillSync(id);
  id[6] = (id[6] & 0x0f) | 0x40;
  id[8] = (id[8] & 0x3f) | 0x80;
  return id;
}

/** type || record_id || payload. */
export function encode(type, id, payload = Buffer.alloc(0)) {
  const out = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  out[0] = type;
  id.copy(out, 1);
  payload.copy(out, HEADER_SIZE);
  return out;
}

/** Split a server message into { type, id, payload }; payload aliases msg. */
export function decode(msg) {
  if (msg.length < HEADER_SIZE) return null;
  return { type: msg[0], id: msg.subarray(1, HEADER_SIZE), payload: msg.subarray(HEADER_SIZE) };
}

export function jsonFrame(type, id, meta) {
  return encode(type, id, Buffer.from(JSON.stringify(meta), "utf8"));
}

export function isCredentialHeader(name) {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

/** Drop credential headers, keeping order and duplicates of the rest. */
export function stripCredentials(headers) {
  return headers.filter(([name]) => !isCredentialHeader(name));
}

function firstHeader(headers, name) {
  for (const [key, value] of headers) if (key.toLowerCase() === name) return value.trim();
  return "";
}

/**
 * docs/protocol.md §3.3: the first Authorization value (trimmed, Bearer prefix
 * included), else the first api-key value, hashed. Computed before credential
 * headers are stripped; the raw credential never leaves this process.
 */
export function userFingerprint(headers) {
  const value = firstHeader(headers, "authorization") || firstHeader(headers, "api-key");
  if (!value) return "";
  return "user_" + createHash("sha256").update(value, "utf8").digest("hex");
}

/** RFC 3339 with nanosecond field (Date only has millisecond precision). */
export function rfc3339Nano(date = new Date()) {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

/** Convert Node rawHeaders ([n, v, n, v, ...]) to [[name, value], ...]. */
export function pairHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}
