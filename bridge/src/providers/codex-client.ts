import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  parseCodexRpcMessage,
  parseInitializeResult,
  type CodexInitializeResult,
  type CodexNotification,
  type CodexServerRequest,
  type JsonRpcId,
} from "./codex-protocol.ts";
import { assertCodexLocalDefaults, type CodexExecutionPolicy } from "./codex-execution.ts";

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type InputStream = Pick<Writable, "write" | "end" | "on">;
type OutputStream = Pick<Readable, "on" | "off">;
export type CodexChild = {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};
export type CodexChildFactory = (args: { command: string; args: string[]; cwd: string }) => CodexChild;

const defaultChildFactory: CodexChildFactory = args => spawn(args.command, args.args, {
  cwd: args.cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

class LineAccumulator {
  private chunks: { bytes: Buffer; start: number }[] = [];
  private newlines: number[] = [];
  private nextNewline = 0;
  private consumed = 0;
  private total = 0;
  get length() { return this.total - this.consumed; }
  push(bytes: Buffer) {
    const start = this.total;
    this.chunks.push({ bytes, start });
    for (let offset = bytes.indexOf(0x0a); offset >= 0; offset = bytes.indexOf(0x0a, offset + 1)) {
      this.newlines.push(start + offset);
    }
    this.total += bytes.length;
  }
  takeLine(): Buffer | undefined {
    const end = this.newlines[this.nextNewline];
    if (end === undefined) return;
    this.nextNewline++;
    if (this.nextNewline === this.newlines.length) { this.newlines = []; this.nextNewline = 0; }
    const length = end - this.consumed;
    const parts = this.chunks.flatMap(chunk => {
      const from = Math.max(this.consumed - chunk.start, 0);
      const to = Math.min(end - chunk.start, chunk.bytes.length);
      return to > from ? [chunk.bytes.subarray(from, to)] : [];
    });
    this.consumed = end + 1;
    this.chunks = this.chunks.filter(chunk => chunk.start + chunk.bytes.length > this.consumed);
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }
  text() { return this.chunks.map(chunk => chunk.bytes.subarray(Math.max(this.consumed - chunk.start, 0)))
    .join(""); }
}

type Pending = {
  method: string;
  parse: (value: unknown) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
};

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export class CodexClient {
  private child?: CodexChild;
  private connectAttempt?: Promise<CodexInitializeResult>;
  private initialized?: CodexInitializeResult;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private optionalAccountingId?: JsonRpcId;
  private optionalAccountingDrain?: { id: JsonRpcId; waiters: Set<() => void> };
  private readonly stdoutBuffer = new LineAccumulator();
  private stderrBuffer = Buffer.alloc(0);
  private terminalError?: Error;
  private nativeOutputBytes = 0;
  private closeObserved = false;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(private readonly args: {
    policy: CodexExecutionPolicy;
    clientVersion: string;
    childFactory?: CodexChildFactory;
    requestTimeoutMs?: number;
    maxLineBytes?: number;
    maxOutputBytes?: number;
    onNativeOutput?: (bytes: number) => void;
    onRequest?: (request: CodexServerRequest) => Promise<unknown>;
    onNotification?: (notification: CodexNotification) => void;
    onTerminal?: (error: Error) => void;
    log: (...values: unknown[]) => void;
  }) {
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
  }

  async connect(): Promise<CodexInitializeResult> {
    if (this.initialized) return this.initialized;
    if (this.terminalError) throw this.terminalError;
    this.connectAttempt ??= this.startAndInitialize();
    return this.connectAttempt;
  }

  async request<T>(args: { method: string; params: unknown; parse: (value: unknown) => T }): Promise<T> {
    await this.connect();
    return this.rawRequest(args);
  }

  hasPendingRequiredRequests() {
    for (const id of this.pending.keys()) if (id !== this.optionalAccountingId) return true;
    return false;
  }

  async requestOptionalAccounting<T>(args: {
    method: "account/usage/read"; params: unknown; parse: (value: unknown) => T; waitForSlot?: boolean;
  }): Promise<T | undefined> {
    await this.connect();
    if (this.optionalAccountingId !== undefined) {
      const drain = this.optionalAccountingDrain;
      if (!args.waitForSlot || !drain) return;
      const available = await new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (value: boolean) => {
          if (timer === undefined) return;
          clearTimeout(timer); timer = undefined; drain.waiters.delete(ready); resolve(value);
        };
        const ready = () => settle(true);
        drain.waiters.add(ready);
        timer = setTimeout(() => settle(false), this.args.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      });
      if (!available || this.optionalAccountingId !== undefined) return;
      if (this.terminalError) throw this.terminalError;
    }
    return this.rawRequest(args, { optionalAccounting: true });
  }

  notify(args: { method: string; params: unknown }) {
    if (!this.initialized) throw new Error("Codex App Server is not initialized");
    this.send({ method: args.method, params: args.params });
  }

  private async startAndInitialize(): Promise<CodexInitializeResult> {
    try {
      assertCodexLocalDefaults();
      const child = (this.args.childFactory ?? defaultChildFactory)({
        command: this.args.policy.command,
        args: this.args.policy.args,
        cwd: this.args.policy.dir,
      });
      this.child = child;
      child.stdin.on("error", this.onStdinError);
      child.stdout.on("data", this.onStdoutData);
      child.stdout.on("end", this.onStdoutEnd);
      child.stderr.on("data", this.onStderrData);
      child.stderr.on("end", this.onStderrEnd);
      child.on("error", this.onChildError);
      child.on("exit", this.onChildExit);
      child.on("close", this.onChildClose);
      const initialized = await this.rawRequest({
        method: "initialize",
        params: {
          clientInfo: { name: "sesori_figma_review", title: "Sesori Figma Review", version: this.args.clientVersion },
          capabilities: { experimentalApi: true },
        },
        parse: parseInitializeResult,
      });
      this.send({ method: "initialized", params: {} });
      this.initialized = initialized;
      return initialized;
    } catch (error) {
      this.terminate(this.error(error));
      throw this.terminalError!;
    }
  }

  private rawRequest<T>(args: { method: string; params: unknown; parse: (value: unknown) => T }): Promise<T>;
  private rawRequest<T>(args: { method: string; params: unknown; parse: (value: unknown) => T },
    options: { optionalAccounting: true }): Promise<T | undefined>;
  private rawRequest<T>(args: { method: string; params: unknown; parse: (value: unknown) => T },
    options: { optionalAccounting?: boolean } = {}): Promise<T | undefined> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    if (options.optionalAccounting) {
      this.optionalAccountingId = id;
      this.optionalAccountingDrain = { id, waiters: new Set() };
    }
    return new Promise<T | undefined>((resolve, reject) => {
      const timeoutMs = this.args.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (options.optionalAccounting && pending) {
          pending.timedOut = true; resolve(undefined); return;
        }
        this.terminate(new Error(`Codex ${args.method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method: args.method,
        parse: args.parse,
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      try { this.send({ id, method: args.method, params: args.params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        this.clearOptionalAccounting(id);
        reject(error);
      }
    });
  }

  private send(message: unknown) {
    if (!this.child || this.terminalError) throw this.terminalError ?? new Error("Codex App Server has not started");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > (this.args.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      throw new Error("Codex RPC message exceeds bounded line limit");
    }
    this.child.stdin.write(line);
  }

  private acceptNativeBytes(bytes: number) {
    this.nativeOutputBytes += bytes;
    try { this.args.onNativeOutput?.(bytes); }
    catch (error) { this.terminate(this.error(error)); return false; }
    if (this.nativeOutputBytes > (this.args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
      this.terminate(new Error("Codex native output exceeds bounded aggregate limit"));
      return false;
    }
    return true;
  }

  private readonly onStdoutData = (chunk: Buffer | string) => {
    if (this.terminalError) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.acceptNativeBytes(bytes.length)) return;
    this.stdoutBuffer.push(bytes);
    const limit = this.args.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    for (;;) {
      if (this.terminalError) return;
      const frame = this.stdoutBuffer.takeLine();
      if (!frame) {
        if (this.stdoutBuffer.length > limit) this.terminate(new Error("Codex stdout line exceeds bounded line limit"));
        return;
      }
      if (frame.length + 1 > limit) {
        this.terminate(new Error("Codex stdout line exceeds bounded line limit")); return;
      }
      const line = frame.toString("utf8").replace(/\r$/, "");
      if (!line.trim()) continue;
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.terminate(new Error(`Malformed Codex RPC message: ${this.error(error).message}`)); return; }
    }
  };

  private receive(value: unknown) {
    const message = parseCodexRpcMessage(value);
    const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
    if (message.method !== undefined) {
      if (hasResult || hasError) throw new Error("request/notification also contains a response payload");
      if (message.id === undefined) {
        this.args.onNotification?.({ method: message.method, params: message.params });
      } else {
        void this.respondToServer({ id: message.id, method: message.method, params: message.params });
      }
      return;
    }
    if (message.id === undefined || hasResult === hasError) throw new Error("invalid response envelope");
    const pending = this.pending.get(message.id);
    if (!pending) throw new Error(`response has unknown id ${JSON.stringify(message.id)}`);
    this.pending.delete(message.id); clearTimeout(pending.timer);
    this.clearOptionalAccounting(message.id);
    if (message.error) {
      if (!pending.timedOut) pending.reject(new CodexRpcError(message.error.code, message.error.message, message.error.data));
      return;
    }
    try {
      const parsed = pending.parse(message.result);
      if (!pending.timedOut) pending.resolve(parsed);
    } catch (error) {
      if (!pending.timedOut) pending.reject(new Error(`Invalid Codex ${pending.method} response: ${this.error(error).message}`));
    }
  }

  private clearOptionalAccounting(id: JsonRpcId) {
    if (this.optionalAccountingId !== id) return;
    this.optionalAccountingId = undefined;
    const drain = this.optionalAccountingDrain;
    this.optionalAccountingDrain = undefined;
    if (drain?.id === id) for (const ready of drain.waiters) ready();
  }

  private async respondToServer(request: CodexServerRequest) {
    try {
      if (!this.args.onRequest) {
        this.send({
          id: request.id,
          error: { code: -32601, message: `Unsupported server request: ${request.method}` },
        });
        return;
      }
      const result = await this.args.onRequest(request);
      this.send({ id: request.id, result });
    } catch (error) {
      try { this.send({ id: request.id, error: { code: -32000, message: this.error(error).message } }); }
      catch (sendError) { if (!this.terminalError) this.terminate(this.error(sendError)); }
    }
  }

  private readonly onStdoutEnd = () => {
    if (this.terminalError) return;
    if (this.stdoutBuffer.text().trim()) {
      this.terminate(new Error("Codex stdout ended with an incomplete RPC frame"));
    } else {
      this.terminate(new Error("Codex App Server stdout closed unexpectedly"));
    }
  };
  private readonly onStdinError = (error: Error) => {
    if (!this.terminalError) this.terminate(new Error(`Codex App Server stdin failed: ${error.message}`));
  };
  private readonly onStderrData = (chunk: Buffer | string) => {
    if (this.terminalError) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.acceptNativeBytes(bytes.length)) return;
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, bytes]);
    const limit = Math.min(this.args.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, 4096);
    for (;;) {
      const newline = this.stderrBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stderrBuffer.length > limit) {
          this.args.log("[codex]", `${this.stderrBuffer.subarray(0, limit).toString("utf8")}…`);
          this.stderrBuffer = Buffer.alloc(0);
        }
        return;
      }
      const line = this.stderrBuffer.subarray(0, Math.min(newline, limit)).toString("utf8").replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.subarray(newline + 1);
      if (line) this.args.log("[codex]", line);
    }
  };
  private flushStderr() {
    if (this.stderrBuffer.length) this.args.log("[codex]", this.stderrBuffer.subarray(0, 4096).toString("utf8"));
    this.stderrBuffer = Buffer.alloc(0);
  }
  private readonly onStderrEnd = () => this.flushStderr();
  private readonly onChildError = (error: Error) =>
    this.terminate(new Error(`Codex App Server failed: ${error.message}`));
  private readonly onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.terminate(new Error(`Codex App Server exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`), false);
  };
  private readonly onChildClose = (code: number | null, signal: NodeJS.Signals | null) => {
    this.closeObserved = true; this.resolveExited();
    if (!this.terminalError) {
      this.terminate(new Error(`Codex App Server closed unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`), false);
    }
  };

  private error(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
  private terminate(error: Error, kill = true) {
    if (this.terminalError) return;
    this.terminalError = error;
    try { this.args.onTerminal?.(error); }
    catch (callbackError) { this.args.log("Codex terminal callback failed", callbackError); }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.optionalAccountingId !== undefined) this.clearOptionalAccounting(this.optionalAccountingId);
    const child = this.child;
    if (!child) return;
    this.flushStderr();
    child.stdout.off("data", this.onStdoutData); child.stdout.off("end", this.onStdoutEnd);
    child.stderr.off("data", this.onStderrData); child.stderr.off("end", this.onStderrEnd);
    child.off("error", this.onChildError);
    try { child.stdin.end(); } catch (cleanupError) { this.args.log("Codex stdin cleanup failed", cleanupError); }
    if (kill) try { child.kill("SIGTERM"); }
    catch (cleanupError) { this.args.log("Codex process cleanup failed", cleanupError); }
  }

  dispose() { this.terminate(new Error("Codex App Server client disposed")); }
  async disposeAndWait(args: { timeoutMs?: number } = {}) {
    this.dispose();
    if (!this.child || this.closeObserved) return;
    const timeoutMs = args.timeoutMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(
          new Error(`Codex App Server retirement was not observed after ${timeoutMs}ms`),
        ), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
