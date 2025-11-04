import { describe, test, beforeAll, afterAll, expect } from "vitest";
import { createTestAbsurd, randomName, type TestContext } from "./setup.js";
import type { Absurd } from "../src/index.js";

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Worker behavior", () => {
  let thelper: TestContext;
  let absurd: Absurd;

  beforeAll(async () => {
    const queueName = randomName("worker_queue");
    thelper = createTestAbsurd(queueName);
    absurd = thelper.absurd;
    await absurd.createQueue(queueName);
  });

  afterAll(async () => {
    await absurd.dropQueue(thelper.queueName);
  });

  test("processes tasks respecting concurrency", async () => {
    await thelper.cleanupTasks();

    const taskName = randomName("worker_concurrency");
    let active = 0;
    let maxConcurrent = 0;

    absurd.registerTask<{ index: number }>(
      { name: taskName },
      async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { done: true };
        } finally {
          active -= 1;
        }
      },
    );

    const worker = await absurd.startWorker({
      concurrency: 2,
      pollInterval: 0.01,
    });

    try {
      const spawned = await Promise.all(
        [0, 1, 2].map((index) => absurd.spawn(taskName, { index })),
      );

      await waitFor(async () => {
        const rows = await Promise.all(
          spawned.map(({ taskID }) => thelper.getTask(taskID)),
        );
        return rows.every((row) => row?.state === "completed");
      });

      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    } finally {
      await worker.close();
    }
  });

  test("invokes onError for failing task", async () => {
    await thelper.cleanupTasks();

    const taskName = randomName("worker_error");
    const seenErrors: Error[] = [];

    absurd.registerTask(
      { name: taskName },
      async () => {
        throw new Error("worker boom");
      },
    );

    const worker = await absurd.startWorker({
      concurrency: 1,
      pollInterval: 0.01,
      fatalOnLeaseTimeout: false,
      onError: (err) => {
        seenErrors.push(err);
      },
    });

    try {
      const { taskID } = await absurd.spawn(taskName);

      await waitFor(async () => {
        const task = await thelper.getTask(taskID);
        return task?.state === "failed";
      });

      expect(seenErrors.length).toBeGreaterThan(0);
      expect(seenErrors[0].message).toBe("worker boom");
    } finally {
      await worker.close();
    }
  });
});
