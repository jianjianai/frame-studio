import dns from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { fail } from "./mcp/workspace.mjs";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  blocked.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  blocked.addSubnet(address, prefix, "ipv6");
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        global6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function assetUrl(value) {
  if (typeof value !== "string")
    fail("INVALID_URL", "Use a public HTTPS download URL.");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_URL", "Use a public HTTPS download URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    value.length > 8192
  )
    fail(
      "INVALID_URL",
      "Use HTTPS on port 443 without credentials or a fragment.",
    );
  return url;
}

const proxyRange = new BlockList();
proxyRange.addSubnet("198.18.0.0", 15, "ipv4");
export async function resolvePublicDns(host, signal) {
  // The resolver connection itself uses a fixed public IP, normal certificate
  // verification and no redirects, independent of a proxy's fake DNS answers.
  const lookupType = (type) =>
    new Promise((resolve, reject) => {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", host);
      url.searchParams.set("type", type);
      const req = https.request(
        url,
        {
          agent: false,
          signal,
          headers: { Accept: "application/dns-json" },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [{ address: "1.1.1.1", family: 4 }])
              : callback(null, "1.1.1.1", 4),
        },
        (response) => {
          let bytes = 0,
            chunks = [];
          response.on("error", reject);
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 65536)
              response.destroy(new Error("DNS response too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks));
              if (
                response.statusCode !== 200 ||
                result.Status !== 0 ||
                result.TC
              )
                throw new Error("Public DNS lookup failed");
              resolve(
                (result.Answer ?? [])
                  .filter((item) => item.type === (type === "A" ? 1 : 28))
                  .map((item) => ({
                    address: item.data,
                    family: type === "A" ? 4 : 6,
                  })),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("Public DNS timeout")));
      req.end();
    });
  return (await Promise.all([lookupType("A"), lookupType("AAAA")])).flat();
}

/** Validate every redirect and pin the TLS connection to the validated DNS answer. */
export async function openPublicAsset(
  value,
  {
    signal,
    lookup = dns.lookup,
    request = https.request,
    publicDns = resolvePublicDns,
  } = {},
) {
  let url = assetUrl(value);
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal?.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let abort;
    let addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          lookup(host, { all: true, verbatim: true }),
          new Promise((_resolve, reject) => {
            abort = () =>
              reject(signal.reason ?? new Error("Download cancelled"));
            signal?.addEventListener("abort", abort, { once: true });
          }),
        ]).finally(() => signal?.removeEventListener("abort", abort));
    signal?.throwIfAborted();
    if (
      !isIP(host) &&
      addresses.length &&
      addresses.every(
        ({ address }) =>
          isIP(address) === 4 && proxyRange.check(address, "ipv4"),
      )
    )
      addresses = await publicDns(host, signal);
    signal?.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some(({ address }) => !publicAddress(address))
    )
      fail(
        "URL_DENIED",
        "Download hosts must resolve only to public internet addresses.",
      );
    const pinned = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          autoSelectFamily: false,
          headers: {
            Accept: "*/*",
            "Accept-Encoding": "identity",
            "User-Agent": "FRAME-Asset-Transfer/1",
          },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [pinned])
              : callback(null, pinned.address, pinned.family),
        },
        resolve,
      );
      req.once("error", reject);
      req.setTimeout(15000, () =>
        req.destroy(new Error("Download idle timeout")),
      );
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location || redirect === 5)
        fail("DOWNLOAD_REDIRECT", "Download exceeded the redirect limit.");
      url = assetUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (
      response.statusCode !== 200 ||
      (response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity")
    ) {
      response.destroy();
      fail("DOWNLOAD_FAILED", "Expected an uncompressed HTTP 200 download.", {
        status: response.statusCode,
      });
    }
    return response;
  }
}
