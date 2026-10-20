// Bypass recording: ships the agents' upstream AI calls to a log-record-sass
// station over lrs.v4. The endpoint and key come from the settings page; the
// station's self-signed certificate is trusted. Capture works by pointing the
// Claude and Codex subprocesses at a local proxy (HTTPS_PROXY) whose CA they
// trust, so it can read their HTTPS traffic. Meant for the Docker image.
import { CertStore, recorderDir, opensslAvailable } from "./ca.mjs";
import { LrsClient } from "./lrs.mjs";
import { RecorderProxy } from "./proxy.mjs";

// AI hosts to intercept and record; everything else tunnels through untouched.
const DEFAULT_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "api.deepseek.com",
  "api.moonshot.cn",
  "open.bigmodel.cn",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
];

export class Recorder {
  constructor({ config, settings, events }) {
    this.config = config;
    this.settings = settings;
    this.events = events;
    this.dir = recorderDir(config);
    this.certStore = new CertStore(this.dir);
    this.lrs = null;
    this.proxy = null;
    this.port = 0;
    this.available = opensslAvailable();
    this.lastError = this.available ? "" : "未找到 openssl，无法生成拦截证书";
  }

  config_() {
    return { enabled: false, url: "", connections: 4, ...(this.settings.get("recorder") || {}) };
  }

  /** Bring the proxy and client up or down to match the settings. */
  async reload() {
    const conf = this.config_();
    const key = this.settings.secret("recorderKey");
    const wanted = Boolean(conf.enabled && conf.url && key && this.available);
    if (!wanted) {
      this.stop();
      return;
    }
    // Restart when the destination changed; otherwise leave the running pool.
    if (this.lrs && (this.lrs.url !== conf.url || this.lrs.key !== key)) this.stop();
    if (this.lrs) return;
    try {
      this.certStore.ensure();
      this.lrs = new LrsClient({ url: conf.url, key, connections: conf.connections, logger: (s, m) => this.#log(s, m) });
      this.lrs.start();
      this.hostSet = new Set([...DEFAULT_HOSTS, ...this.#profileHosts()]);
      this.proxy = new RecorderProxy({
        certStore: this.certStore,
        lrs: this.lrs,
        shouldRecord: (host) => this.#shouldRecord(host),
        logger: (s, m) => this.#log(s, m),
      });
      this.port = await this.proxy.listen("127.0.0.1");
      this.lastError = "";
    } catch (error) {
      this.lastError = String(error?.message || error);
      this.stop();
    }
  }

  stop() {
    this.proxy?.close();
    this.lrs?.stop();
    this.proxy = null;
    this.lrs = null;
    this.port = 0;
  }

  get running() {
    return Boolean(this.lrs && this.port);
  }

  /** Environment that routes an agent's HTTPS through the proxy and trusts its CA. */
  agentEnv() {
    if (!this.running) return {};
    const proxy = `http://127.0.0.1:${this.port}`;
    const noProxy = "127.0.0.1,localhost,::1,0.0.0.0";
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NODE_EXTRA_CA_CERTS: this.certStore.caCertPath(), // Claude (Node) appends this
      SSL_CERT_FILE: this.certStore.bundlePath(), // Codex (rustls via openssl-probe)
    };
  }

  status() {
    const conf = this.config_();
    return {
      enabled: Boolean(conf.enabled),
      url: conf.url || "",
      hasKey: this.settings.hasSecret("recorderKey"),
      connections: conf.connections,
      available: this.available,
      running: this.running,
      proxyPort: this.port,
      lastError: this.lastError,
      stats: this.lrs ? this.lrs.statsView() : null,
    };
  }

  #profileHosts() {
    const hosts = [];
    for (const profile of this.settings.get("ai")?.profiles || []) {
      if (!profile.baseUrl) continue;
      try {
        hosts.push(new URL(profile.baseUrl).hostname);
      } catch {}
    }
    return hosts;
  }

  #shouldRecord(host) {
    for (const h of this.hostSet) if (host === h || host.endsWith("." + h)) return true;
    return false;
  }

  #log(scope, message) {
    this.lastError = message;
    this.events?.emit({ type: "recorder", scope, message });
  }
}
