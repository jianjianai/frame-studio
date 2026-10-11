import fs from "node:fs";
import path from "node:path";
import { Lru } from "./util.mjs";

const FAILED_FOR = 5 * 60 * 1000; // a picture that fails is tried again after this (or as soon as its source changes: another name)

/**
 * Small pictures the headless browser renders in the background (resources, models, Lottie
 * animations, panoramas, fonts): one at a time, the latest request first (what a panel
 * shows now), cached as files named by what they show and its version. A failure is
 * remembered for a while instead of being rendered again on every request.
 */
export class Thumbnails {
  constructor(dir) {
    this.dir = dir;
    this.jobs = new Map(); // file → job, waiting or being rendered
    this.waiting = []; // files not started yet, latest request last
    this.rendering = null; // the file being rendered
    this.failed = new Lru(2000); // file → { message, at }
  }

  /**
   * `{ file }` when it is there, `{ error }` when it failed lately, else `{ pending: true }`:
   * then `job.render(file)` makes it later and `job.done(error?)` says it is over.
   */
  request(name, job) {
    const file = path.join(this.dir, name);
    if (fs.existsSync(file)) return { file };
    const failed = this.failed.get(file);
    if (failed && Date.now() - failed.at < FAILED_FOR) return { error: failed.message };
    if (!this.jobs.has(file)) this.jobs.set(file, job);
    if (this.rendering !== file) {
      const index = this.waiting.indexOf(file);
      if (index >= 0) this.waiting.splice(index, 1);
      this.waiting.push(file);
      this.next();
    }
    return { pending: true };
  }

  next() {
    if (this.rendering || !this.waiting.length) return;
    const file = (this.rendering = this.waiting.pop());
    const job = this.jobs.get(file);
    const done = (error) => {
      if (error) this.failed.set(file, { message: error.message, at: Date.now() });
      else this.failed.delete(file);
      job.done?.(error);
    };
    Promise.resolve()
      .then(() => fs.mkdirSync(this.dir, { recursive: true }))
      .then(() => job.render(file))
      .then(() => done(), done)
      .finally(() => {
        this.jobs.delete(file);
        this.rendering = null;
        this.next();
      });
  }

  /** Forget waiting jobs that are not wanted any more (`unwanted(job)` may be async). */
  async drop(unwanted) {
    for (const file of [...this.waiting]) {
      const job = this.jobs.get(file);
      if (!job || !(await unwanted(job))) continue;
      const index = this.waiting.indexOf(file);
      if (index >= 0) this.waiting.splice(index, 1);
      this.jobs.delete(file);
    }
  }
}
