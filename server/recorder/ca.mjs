// A self-signed CA for the recording proxy, plus per-host leaf certificates it
// signs on demand. Generated with the openssl CLI (no extra dependency); the
// agents are told to trust it (Claude via NODE_EXTRA_CA_CERTS, Codex via a
// combined SSL_CERT_FILE bundle). Only used inside the container.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";

const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"; // Debian/Ubuntu (the image)

function openssl(args, input) {
  return execFileSync("openssl", args, { input, stdio: ["pipe", "pipe", "pipe"] });
}

/** Whether the openssl CLI is usable here (the proxy needs it to make certs). */
export function opensslAvailable() {
  try {
    openssl(["version"]);
    return true;
  } catch {
    return false;
  }
}

export class CertStore {
  constructor(dir) {
    this.dir = dir;
    this.caKey = path.join(dir, "ca.key");
    this.caCert = path.join(dir, "ca.crt");
    this.leafKey = path.join(dir, "leaf.key");
    this.bundle = path.join(dir, "ca-bundle.crt"); // system roots + our CA, for SSL_CERT_FILE
    this.contexts = new Map(); // host -> tls.SecureContext
  }

  /** Make the CA, the shared leaf key and the trust bundle once. */
  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.caKey) || !fs.existsSync(this.caCert)) {
      openssl([
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", this.caKey, "-out", this.caCert,
        "-days", "3650", "-subj", "/CN=FRAME Studio Recorder CA",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      ]);
      fs.chmodSync(this.caKey, 0o600);
    }
    if (!fs.existsSync(this.leafKey)) {
      openssl(["genrsa", "-out", this.leafKey, "2048"]);
      fs.chmodSync(this.leafKey, 0o600);
    }
    // Codex's TLS (rustls via openssl-probe) reads one file and replaces the
    // default roots, so the bundle must carry both the system roots and our CA.
    const parts = [];
    try {
      parts.push(fs.readFileSync(SYSTEM_BUNDLE, "utf8"));
    } catch {}
    parts.push(fs.readFileSync(this.caCert, "utf8"));
    fs.writeFileSync(this.bundle, parts.join("\n"));
  }

  /** Path agents trust: our CA alone (NODE_EXTRA_CA_CERTS appends to Node's roots). */
  caCertPath() {
    return this.caCert;
  }

  /** Path with system roots + our CA (SSL_CERT_FILE replaces the default set). */
  bundlePath() {
    return fs.existsSync(this.bundle) ? this.bundle : this.caCert;
  }

  /** A TLS context presenting a leaf for `host`, signed by the CA. Cached. */
  contextFor(host) {
    let ctx = this.contexts.get(host);
    if (ctx) return ctx;
    const safe = /^[a-zA-Z0-9.-]+$/.test(host) ? host : "invalid.host";
    const csrFile = path.join(this.dir, "leaf.csr");
    const extFile = path.join(this.dir, "leaf.ext");
    // SAN must match the host the agent asked for, or it rejects the cert.
    fs.writeFileSync(extFile, `subjectAltName=DNS:${safe}\nextendedKeyUsage=serverAuth\n`);
    openssl(["req", "-new", "-key", this.leafKey, "-subj", `/CN=${safe}`, "-out", csrFile]);
    const pem = openssl([
      "x509", "-req", "-in", csrFile, "-CA", this.caCert, "-CAkey", this.caKey,
      "-CAcreateserial", "-days", "825", "-extfile", extFile,
    ]).toString();
    ctx = tls.createSecureContext({ key: fs.readFileSync(this.leafKey), cert: pem });
    this.contexts.set(host, ctx);
    return ctx;
  }
}

/** The recorder's working directory inside the data home. */
export function recorderDir(config) {
  return path.join(config.home || os.homedir(), "recorder");
}
