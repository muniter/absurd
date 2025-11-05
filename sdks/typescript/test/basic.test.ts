import { describe, test, assert, expect, beforeAll, afterAll } from "vitest";
import { createTestAbsurd, randomName, type TestContext } from "./setup.js";
import type { Absurd } from "../src/index.js";

describe("Basic SDK Operations", () => {
  let thelper: TestContext;
  let absurd: Absurd;

  beforeAll(async () => {
    const queueName = randomName("test_queue");
    thelper = createTestAbsurd(queueName);
    absurd = thelper.absurd;
    await thelper.setup();
  });

  afterAll(async () => {
    await thelper.teardown();
  });

  describe("Queue management", () => {
    test("create, list, and drop queue", async () => {
      const queueName = randomName("test_queue");

      await absurd.createQueue(queueName);

      let queues = await absurd.listQueues();
      expect(queues).toContain(queueName);

      const tables = await thelper.pool.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'absurd'
          AND tablename LIKE '%_${queueName}'
        ORDER BY tablename
      `);
      expect(tables.rows.length).toBe(5);
      expect(tables.rows.map((r) => r.tablename).sort()).toEqual([
        `c_${queueName}`,
        `e_${queueName}`,
        `r_${queueName}`,
        `t_${queueName}`,
        `w_${queueName}`,
      ]);

      await absurd.dropQueue(queueName);

      queues = await absurd.listQueues();
      expect(queues).not.toContain(queueName);

      const droppedTables = await thelper.pool.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'absurd'
          AND tablename LIKE '%_${queueName}'
      `);
      expect(droppedTables.rows.length).toBe(0);
    });
  });

  describe("Task spawning", () => {
    test("spawn with maxAttempts override", async () => {
      absurd.registerTask<{ shouldFail: boolean }>(
        { name: "test-max-attempts", defaultMaxAttempts: 5 },
        async (params) => {
          if (params.shouldFail) {
            throw new Error("Always fails");
          }
          return { success: true };
        }
      );

      const { taskID } = await absurd.spawn(
        "test-max-attempts",
        { shouldFail: true },
        { maxAttempts: 2 }
      );

      await absurd.workBatch("test-worker-attempts", 60, 1);
      await absurd.workBatch("test-worker-attempts", 60, 1);

      const task = await thelper.getTask(taskID);
      expect(task).toMatchObject({
        state: "failed",
        attempts: 2,
      });
    });

    test("rejects spawning unregistered task without queue override", async () => {
      await expect(
        absurd.spawn("unregistered-task", { value: 1 }),
      ).rejects.toThrowError(
        "Task \"unregistered-task\" is not registered. Provide options.queue when spawning unregistered tasks.",
      );
    });

    test("rejects spawning registered task on mismatched queue", async () => {
      const taskName = "registered-queue-task";
      const otherQueue = randomName("other_queue");

      absurd.registerTask(
        { name: taskName, queue: thelper.queueName },
        async () => ({ success: true }),
      );

      await expect(
        absurd.spawn(taskName, undefined, { queue: otherQueue }),
      ).rejects.toThrowError(
        `Task "${taskName}" is registered for queue "${thelper.queueName}" but spawn requested queue "${otherQueue}".`,
      );
    });
  });

  describe("Task claiming", () => {
    test("claim tasks with various batch sizes", async () => {
      await thelper.cleanupTasks();

      absurd.registerTask<{ id: number }>(
        { name: "test-claim" },
        async (params) => {
          return { id: params.id };
        }
      );

      // Spawn multiple tasks
      const spawned = await Promise.all([1, 2, 3].map(id => 
        absurd.spawn("test-claim", { id })
      ));

      // Test batch claim
      const claimed = await absurd.claimTasks({
        batchSize: 3,
        claimTimeout: 60,
        workerId: "test-worker",
      });

      expect(claimed.length).toBe(3);
      expect(claimed.map(c => c.task_id).sort()).toEqual(spawned.map(s => s.taskID).sort());

      // Verify tasks are now in running state
      const task = await thelper.getTask(spawned[0].taskID);
      expect(task?.state).toBe("running");

      // Test empty queue
      const emptyClaim = await absurd.claimTasks({
        batchSize: 10,
        claimTimeout: 60,
        workerId: "test-worker-empty",
      });
      expect(emptyClaim).toEqual([]);
    });
  });


  describe("Task state transitions", () => {
    test("task transitions through all states: pending -> running -> completed", async () => {
      absurd.registerTask<{ value: number }>(
        { name: "test-task-complete" },
        async (params, ctx) => {
          const doubled = await ctx.step("double", async () => {
            return params.value * 2;
          });
          return { doubled };
        }
      );

      const { taskID } = await absurd.spawn("test-task-complete", { value: 21 });

      // Initial: pending
      expect((await thelper.getTask(taskID))?.state).toBe("pending");

      // Claim and execute
      const claimed = await absurd.claimTasks({
        batchSize: 1,
        claimTimeout: 60,
        workerId: "test-worker-complete",
      });
      assert(claimed[0]);
      expect((await thelper.getTask(taskID))?.state).toBe("running");

      await absurd.executeTask(claimed[0], 60);

      // Final: completed
      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "completed",
        attempts: 1,
        completed_payload: { doubled: 42 },
      });
    });

    test("task transitions to sleeping state when suspended", async () => {
      const eventName = randomName("suspend_event");
      absurd.registerTask(
        { name: "test-task-suspend" },
        async (params, ctx) => {
          return { received: await ctx.awaitEvent(eventName) };
        }
      );

      const { taskID } = await absurd.spawn("test-task-suspend", undefined);

      // Process task (suspends waiting for event)
      await absurd.workBatch("test-worker-suspend", 60, 1);
      expect((await thelper.getTask(taskID))?.state).toBe("sleeping");

      // Emit event and resume
      await absurd.emitEvent(eventName, { data: "wakeup" });
      await absurd.workBatch("test-worker-suspend", 60, 1);

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "completed",
        completed_payload: { received: { data: "wakeup" } },
      });
    });

    test("task transitions to failed state after all retries exhausted", async () => {
      absurd.registerTask(
        { name: "test-task-fail", defaultMaxAttempts: 1 },
        async () => {
          throw new Error("Task intentionally failed");
        }
      );

      const { taskID, runID } = await absurd.spawn("test-task-fail", undefined);
      await absurd.workBatch("test-worker-fail", 60, 1);

      expect((await thelper.getTask(taskID))?.state).toBe("failed");
      expect(await thelper.getRun(runID)).toMatchObject({
        state: "failed",
        failure_reason: expect.objectContaining({
          message: "Task intentionally failed",
        }),
      });
    });
  });

  describe("Event system", () => {
    test("event emitted before await is cached", async () => {
      absurd.registerTask<{ eventName: string }, { received: any }>(
        { name: "test-cached-event" },
        async (params, ctx) => {
          const payload = await ctx.awaitEvent(params.eventName);
          return { received: payload };
        }
      );

      const eventName = randomName("test_event");

      await absurd.emitEvent(eventName, { data: "cached-payload" });

      const { taskID } = await absurd.spawn("test-cached-event", { eventName });

      await absurd.workBatch("test-worker-cached", 60, 1);

      const taskInfo = await thelper.getTask(taskID);
      assert(taskInfo);
      expect(taskInfo).toMatchObject({
        state: "completed",
        completed_payload: { received: { data: "cached-payload" } },
      });
    });
  });

  describe("Batch processing", () => {
    test("workBatch processes multiple tasks", async () => {
      absurd.registerTask<{ id: number }>(
        { name: "test-work-batch" },
        async (params) => {
          return { result: `task-${params.id}` };
        }
      );

      const tasks = await Promise.all([1, 2, 3].map(id =>
        absurd.spawn("test-work-batch", { id })
      ));

      await absurd.workBatch("test-worker-batch", 60, 5);

      for (const [i, task] of tasks.entries()) {
        expect(await thelper.getTask(task.taskID)).toMatchObject({
          state: "completed",
          completed_payload: { result: `task-${i + 1}` },
        });
      }
    });

    test("workBatch handles mixed success and failure", async () => {
      absurd.registerTask<{ shouldFail: boolean }>(
        { name: "test-work-batch-mixed", defaultMaxAttempts: 1 },
        async (params) => {
          if (params.shouldFail) {
            throw new Error("Task failed in batch");
          }
          return { success: true };
        }
      );

      const failTask = await absurd.spawn("test-work-batch-mixed", { shouldFail: true });
      const successTask = await absurd.spawn("test-work-batch-mixed", { shouldFail: false });

      await absurd.workBatch("test-worker-batch-mixed", 60, 2);

      expect((await thelper.getTask(failTask.taskID))?.state).toBe("failed");
      expect(await thelper.getTask(successTask.taskID)).toMatchObject({
        state: "completed",
        completed_payload: { success: true },
      });
    });
  });
});
