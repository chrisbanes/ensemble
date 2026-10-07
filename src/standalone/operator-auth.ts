import {
  createHash,
  randomBytes as nodeRandomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const FORMAT = "ensemble-operator-auth";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_LOGIN_FAILURE_LIMIT = 5;
const DEFAULT_LOGIN_LOCKOUT_MS = 60 * 1_000;
const MAX_ACTIVE_DERIVATIONS = 4;
const MAX_SESSIONS = 256;
const MAX_AUTH_FILE_BYTES = 4_096;

type RandomBytes = (size: number) => Buffer;

type PasswordRecord = {
  format: typeof FORMAT;
  version: 1;
  algorithm: "scrypt";
  cost: number;
  blockSize: number;
  parallelism: number;
  salt: string;
  verifier: string;
};

type SessionRecord = {
  idHash: string;
  csrfToken: string;
  authenticated: boolean;
  createdAt: number;
  lastUsedAt: number;
};

export type OperatorSession = {
  id: string;
  csrfToken: string;
  authenticated: boolean;
};

export type OperatorAuthOptions = {
  authFile: string;
  origin: string;
  now?: () => number;
  randomBytes?: RandomBytes;
  derivePassword?: (password: string) => Promise<Buffer>;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  loginFailureLimit?: number;
  loginLockoutMs?: number;
};

function invalidAuthConfiguration(): Error {
  return new Error("Operator authentication configuration is invalid");
}

function random(randomBytes: RandomBytes, size: number): Buffer {
  const result = randomBytes(size);
  if (!Buffer.isBuffer(result) || result.length !== size)
    throw invalidAuthConfiguration();
  return result;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

function canonicalOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol === "http:" && url.hostname !== "127.0.0.1")
    ) {
      throw invalidAuthConfiguration();
    }
    return url;
  } catch {
    throw invalidAuthConfiguration();
  }
}

function deriveVerifier(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function decodeBase64Url(value: unknown, length: number): Buffer {
  if (typeof value !== "string") throw invalidAuthConfiguration();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length || decoded.toString("base64url") !== value)
    throw invalidAuthConfiguration();
  return decoded;
}

function parsePasswordRecord(contents: string): PasswordRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalidAuthConfiguration();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidAuthConfiguration();
  const record = parsed as Partial<PasswordRecord>;
  const keys = [
    "format",
    "version",
    "algorithm",
    "cost",
    "blockSize",
    "parallelism",
    "salt",
    "verifier",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    record.format !== FORMAT ||
    record.version !== 1 ||
    record.algorithm !== "scrypt" ||
    record.cost !== SCRYPT_COST ||
    record.blockSize !== SCRYPT_BLOCK_SIZE ||
    record.parallelism !== SCRYPT_PARALLELISM
  ) {
    throw invalidAuthConfiguration();
  }
  decodeBase64Url(record.salt, SALT_LENGTH);
  decodeBase64Url(record.verifier, KEY_LENGTH);
  return record as PasswordRecord;
}

async function writePasswordRecord(
  authFile: string,
  record: PasswordRecord,
  randomBytes: RandomBytes,
): Promise<void> {
  if (!isAbsolute(authFile)) throw invalidAuthConfiguration();
  const directory = dirname(authFile);
  const contents = `${JSON.stringify(record)}\n`;
  let temporaryFile: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // link() creates the final name without replacing a file created by a racing init.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      temporaryFile = join(
        directory,
        `.${basename(authFile)}.${random(randomBytes, 16).toString("hex")}.tmp`,
      );
      try {
        handle = await open(temporaryFile, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!handle || !temporaryFile) throw invalidAuthConfiguration();
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryFile, authFile);
    await unlink(temporaryFile);
    temporaryFile = undefined;
  } catch {
    throw new Error("Could not initialize operator authentication");
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryFile) await unlink(temporaryFile).catch(() => undefined);
  }
}

export class OperatorAuth {
  readonly origin: string;

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly randomBytes: RandomBytes;
  private readonly derivePassword: (password: string) => Promise<Buffer>;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly loginFailureLimit: number;
  private readonly loginLockoutMs: number;
  private readonly salt: Buffer;
  private readonly verifier: Buffer;
  private readonly derivingSessions = new Set<SessionRecord>();
  private activeDerivations = 0;
  private failedLogins = 0;
  private lockedUntil = 0;
  private closed = false;

  private constructor(options: OperatorAuthOptions, record: PasswordRecord) {
    this.origin = canonicalOrigin(options.origin).origin;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs =
      options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
    this.loginFailureLimit =
      options.loginFailureLimit ?? DEFAULT_LOGIN_FAILURE_LIMIT;
    this.loginLockoutMs = options.loginLockoutMs ?? DEFAULT_LOGIN_LOCKOUT_MS;
    if (
      !Number.isSafeInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 1 ||
      !Number.isSafeInteger(this.absoluteTimeoutMs) ||
      this.absoluteTimeoutMs < this.idleTimeoutMs ||
      !Number.isSafeInteger(this.loginFailureLimit) ||
      this.loginFailureLimit < 1 ||
      !Number.isSafeInteger(this.loginLockoutMs) ||
      this.loginLockoutMs < 1
    ) {
      throw invalidAuthConfiguration();
    }
    this.salt = decodeBase64Url(record.salt, SALT_LENGTH);
    this.verifier = decodeBase64Url(record.verifier, KEY_LENGTH);
    this.derivePassword =
      options.derivePassword ??
      ((password) => deriveVerifier(password, this.salt));
  }

  static async initialize(
    authFile: string,
    password: string,
    randomBytes: RandomBytes = nodeRandomBytes,
  ): Promise<void> {
    try {
      if (!isAbsolute(authFile) || typeof password !== "string" || !password)
        throw invalidAuthConfiguration();
      const salt = random(randomBytes, SALT_LENGTH);
      const verifier = await deriveVerifier(password, salt);
      await writePasswordRecord(
        authFile,
        {
          format: FORMAT,
          version: 1,
          algorithm: "scrypt",
          cost: SCRYPT_COST,
          blockSize: SCRYPT_BLOCK_SIZE,
          parallelism: SCRYPT_PARALLELISM,
          salt: salt.toString("base64url"),
          verifier: verifier.toString("base64url"),
        },
        randomBytes,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Could not initialize operator authentication"
      ) {
        throw error;
      }
      throw new Error("Could not initialize operator authentication");
    }
  }

  static async open(options: OperatorAuthOptions): Promise<OperatorAuth> {
    try {
      if (!options || typeof options !== "object")
        throw invalidAuthConfiguration();
      canonicalOrigin(options.origin);
      if (!isAbsolute(options.authFile)) throw invalidAuthConfiguration();
      const owner = process.getuid?.();
      if (owner === undefined) throw invalidAuthConfiguration();
      const before = await lstat(options.authFile);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== owner ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > MAX_AUTH_FILE_BYTES
      ) {
        throw invalidAuthConfiguration();
      }
      const handle = await open(
        options.authFile,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let contents: string;
      try {
        const actual = await handle.stat();
        if (
          !actual.isFile() ||
          actual.uid !== owner ||
          (actual.mode & 0o777) !== 0o600 ||
          actual.size > MAX_AUTH_FILE_BYTES
        ) {
          throw invalidAuthConfiguration();
        }
        contents = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
      const record = parsePasswordRecord(contents);
      return new OperatorAuth(options, record);
    } catch {
      throw invalidAuthConfiguration();
    }
  }

  createAnonymousSession(): OperatorSession {
    return this.createSession(false);
  }

  async authenticate(
    id: string,
    password: string,
  ): Promise<OperatorSession | undefined> {
    if (this.closed || this.now() < this.lockedUntil) return undefined;
    const current = this.lookup(id);
    if (
      !current ||
      current.authenticated ||
      typeof password !== "string" ||
      this.derivingSessions.has(current) ||
      this.activeDerivations >= MAX_ACTIVE_DERIVATIONS
    ) {
      return undefined;
    }
    this.derivingSessions.add(current);
    this.activeDerivations += 1;
    try {
      let candidate: Buffer;
      try {
        candidate = await this.derivePassword(password);
      } catch {
        return undefined;
      }
      if (
        this.closed ||
        this.now() < this.lockedUntil ||
        !Buffer.isBuffer(candidate) ||
        candidate.length !== this.verifier.length
      ) {
        return undefined;
      }
      if (!timingSafeEqual(candidate, this.verifier)) {
        this.failedLogins += 1;
        if (this.failedLogins >= this.loginFailureLimit) {
          this.failedLogins = 0;
          this.lockedUntil = this.now() + this.loginLockoutMs;
        }
        return undefined;
      }
      const latest = this.lookup(id);
      if (
        this.closed ||
        this.now() < this.lockedUntil ||
        latest !== current ||
        latest.authenticated
      ) {
        return undefined;
      }
      this.failedLogins = 0;
      this.lockedUntil = 0;
      this.deleteSession(id);
      return this.createSession(true);
    } finally {
      this.derivingSessions.delete(current);
      this.activeDerivations -= 1;
    }
  }

  getSession(id: string): OperatorSession | undefined {
    const record = this.lookup(id);
    if (!record) return undefined;
    record.lastUsedAt = this.now();
    return this.view(record, id);
  }

  validateCsrf(id: string, token: string): boolean {
    const record = this.lookup(id);
    return Boolean(
      record && typeof token === "string" && safeEqual(record.csrfToken, token),
    );
  }

  logout(id: string): void {
    this.deleteSession(id);
  }

  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.failedLogins = 0;
    this.lockedUntil = 0;
  }

  private createSession(authenticated: boolean): OperatorSession {
    if (this.closed) throw invalidAuthConfiguration();
    this.removeExpiredSessions();
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestAnonymous = [...this.sessions.values()]
        .filter((session) => !session.authenticated)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldestAnonymous) throw invalidAuthConfiguration();
      this.sessions.delete(oldestAnonymous.idHash);
    }
    const id = random(this.randomBytes, 32).toString("base64url");
    const csrfToken = random(this.randomBytes, 32).toString("base64url");
    const now = this.now();
    const idHash = sha256(id).toString("hex");
    this.sessions.set(idHash, {
      idHash,
      csrfToken,
      authenticated,
      createdAt: now,
      lastUsedAt: now,
    });
    return { id, csrfToken, authenticated };
  }

  private lookup(id: string): SessionRecord | undefined {
    if (this.closed || typeof id !== "string" || id.length > 64)
      return undefined;
    const idHash = sha256(id).toString("hex");
    const record = this.sessions.get(idHash);
    if (!record) return undefined;
    const now = this.now();
    if (
      now - record.lastUsedAt >= this.idleTimeoutMs ||
      now - record.createdAt >= this.absoluteTimeoutMs
    ) {
      this.sessions.delete(idHash);
      return undefined;
    }
    return record;
  }

  private deleteSession(id: string): void {
    if (typeof id === "string" && id.length <= 64)
      this.sessions.delete(sha256(id).toString("hex"));
  }

  private removeExpiredSessions(): void {
    const now = this.now();
    for (const [idHash, session] of this.sessions) {
      if (
        now - session.lastUsedAt >= this.idleTimeoutMs ||
        now - session.createdAt >= this.absoluteTimeoutMs
      ) {
        this.sessions.delete(idHash);
      }
    }
  }

  private view(record: SessionRecord, id: string): OperatorSession {
    return {
      id,
      csrfToken: record.csrfToken,
      authenticated: record.authenticated,
    };
  }
}
