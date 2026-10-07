type HeldDerivation = {
  correct: boolean;
  settled: boolean;
  resolve(candidate: Buffer): void;
  reject(error: unknown): void;
};

type CallWaiter = {
  count: number;
  resolve(): void;
};

export function createControlledPasswordDeriver(
  correctPassword: string,
  verifier: Buffer,
) {
  const incorrectCandidate = Buffer.alloc(verifier.length, 0xff);
  const calls: HeldDerivation[] = [];
  const waiters: CallWaiter[] = [];

  const notifyWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter) continue;
      if (calls.length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const derivePassword = (password: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const call: HeldDerivation = {
        correct: password === correctPassword,
        settled: false,
        resolve(candidate) {
          if (call.settled) return;
          call.settled = true;
          resolve(candidate);
        },
        reject(error) {
          if (call.settled) return;
          call.settled = true;
          reject(error);
        },
      };
      calls.push(call);
      notifyWaiters();
    });

  return {
    calls,
    derivePassword,
    async waitForCalls(count: number) {
      if (calls.length >= count) return;
      await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    release(index: number) {
      const call = calls[index];
      if (!call) throw new Error("No held password derivation at index");
      call.resolve(Buffer.from(call.correct ? verifier : incorrectCandidate));
    },
    resolve(index: number, candidate: Buffer) {
      const call = calls[index];
      if (!call) throw new Error("No held password derivation at index");
      call.resolve(candidate);
    },
    reject(
      index: number,
      error: unknown = new Error("fixture derivation failed"),
    ) {
      const call = calls[index];
      if (!call) throw new Error("No held password derivation at index");
      call.reject(error);
    },
    releaseAll() {
      for (let index = 0; index < calls.length; index += 1) this.release(index);
    },
  };
}
