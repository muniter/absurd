import { describe, test, assert, expect, beforeAll, beforeEach } from "vitest";
import { createTestAbsurd, randomName, type TestContext } from "./setup.js";
import type { Absurd } from "../src/index.js";

describe("Basic SDK Operations", () => {
  let thelper: TestContext;
  let absurd: Absurd;

  beforeAll(async () => {
    const queueName = randomName("test_queue");
    thelper = createTestAbsurd(queueName);
    absurd = thelper.absurd;
    await absurd.createQueue(queueName);
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
  });

  describe("Task claiming", () => {
    beforeEach(async () => {
      await thelper.cleanupTasks();
    });

    test("claim single task", async () => {
      const spawnResult = await thelper.absurd.spawn(
        "test-task",
        {
          data: "test-value",
        },
        { queue: thelper.queueName }
      );

      expect(spawnResult).toMatchObject({
        taskID: expect.any(String),
        runID: expect.any(String),
        attempt: 1,
      });

      let taskState = await thelper.getTask(spawnResult.taskID);
      assert(taskState && taskState.state === "pending");
      const claimed = await thelper.absurd.claimTasks({
        batchSize: 1,
        claimTimeout: 60,
        workerId: "test-worker",
      });
      expect(claimed.length).toBe(1);
      assert(claimed[0]);
      expect(claimed[0]).toMatchObject({
        task_id: spawnResult.taskID,
        run_id: spawnResult.runID,
        attempt: spawnResult.attempt,
      });
      taskState = await thelper.getTask(spawnResult.taskID);
      assert(taskState);
      assert(taskState.state === "running");
    });

    test("claim multiple tasks with batchSize > 1", async () => {
      await thelper.cleanupTasks();

      absurd.registerTask<{ id: number }>(
        { name: "test-multi-claim" },
        async (params) => {
          return { id: params.id };
        }
      );

      const spawned = [
        await absurd.spawn("test-multi-claim", { id: 1 }),
        await absurd.spawn("test-multi-claim", { id: 2 }),
        await absurd.spawn("test-multi-claim", { id: 3 }),
      ];

      const claimed = await absurd.claimTasks({
        batchSize: 3,
        claimTimeout: 60,
        workerId: "test-worker-multi",
      });

      expect(claimed.length).toBe(3);
      const claimedTaskIds = claimed.map((c) => c.task_id).sort();
      const spawnedTaskIds = spawned.map((s) => s.taskID).sort();
      expect(claimedTaskIds).toEqual(spawnedTaskIds);

      const claimedRunIds = claimed.map((c) => c.run_id).sort();
      const spawnedRunIds = spawned.map((s) => s.runID).sort();
      expect(claimedRunIds).toEqual(spawnedRunIds);
    });

    test("claim from empty queue returns empty array", async () => {
      const claimed = await absurd.claimTasks({
        batchSize: 10,
        claimTimeout: 60,
        workerId: "test-worker-empty-claim",
      });
      expect(claimed).toEqual([]);
    });
  });

  describe("Task execution", () => {
    test("execute task successfully", async () => {
      thelper.absurd.registerTask<{ input: string }>(
        { name: "test-task-execute" },
        async (params, ctx) => {
          const step1 = await ctx.step("step1", async () => {
            return "step-1";
          });
          return { steps: [step1], input: params.input };
        }
      );

      const spawnResult = await absurd.spawn("test-task-execute", {
        input: "test-value",
      });

      await absurd.workBatch("test-worker", 60, 1);
      const taskInfo = await thelper.getTask(spawnResult.taskID);
      assert(taskInfo);
      assert(taskInfo.state === "completed");
      expect(taskInfo.completed_payload).toEqual({
        steps: ["step-1"],
        input: "test-value",
      });
      expect(taskInfo.attempts).toBe(1);
    });
  });

  describe("Task and run status", () => {
    test("getTask and getRun return task and run state", async () => {
      absurd.registerTask<{ value: number }>(
        { name: "test-task-get-state" },
        async (params, ctx) => {
          const doubled = await ctx.step("double", async () => {
            return params.value * 2;
          });
          return { doubled };
        }
      );

      const { taskID, runID } = await absurd.spawn("test-task-get-state", {
        value: 21,
      });

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "pending",
        attempts: expect.any(Number),
      });
      expect(await thelper.getRun(runID)).toMatchObject({
        state: "pending",
        available_at: expect.any(Date),
      });

      // Process the task
      const claimed = await absurd.claimTasks({
        batchSize: 1,
        claimTimeout: 60,
        workerId: "test-worker-get-state",
      });
      assert(claimed.length === 1 && claimed[0]);
      const claimedTask = claimed[0]!;
      expect(claimedTask).toMatchObject({
        task_id: taskID,
        run_id: runID,
      });

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "running",
        attempts: 1,
      });
      expect(await thelper.getRun(runID)).toMatchObject({
        state: "running",
        started_at: expect.any(Date),
      });

      await absurd.executeTask(claimedTask, 60);

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "completed",
        attempts: 1,
        completed_payload: { doubled: 42 },
        // Note: completed_at is on the run table, not the task table
      });
      expect(await thelper.getRun(runID)).toMatchObject({
        state: "completed",
        completed_at: expect.any(Date),
        result: { doubled: 42 },
      });
    });

    test("getTask and getRun return error for failed task", async () => {
      absurd.registerTask<{ shouldFail: boolean }>(
        { name: "test-task-fail", defaultMaxAttempts: 1 },
        async (params) => {
          if (params.shouldFail) {
            throw new Error("Task intentionally failed");
          }
          return { success: true };
        }
      );

      const { taskID, runID } = await absurd.spawn("test-task-fail", {
        shouldFail: true,
      });

      await absurd.workBatch("test-worker-fail", 60, 1);
      const failedTask = await thelper.getTask(taskID);
      expect(failedTask).toMatchObject({
        state: "failed",
      });
      const failedRun = await thelper.getRun(runID);
      expect(failedRun).toMatchObject({
        state: "failed",
        failure_reason: expect.objectContaining({
          message: "Task intentionally failed",
        }),
        failed_at: expect.any(Date),
      });
    });

    test("getTask and getRun return null for non-existent task", async () => {
      expect(
        await thelper.getTask("00000000-0000-0000-0000-000000000000")
      ).toBeNull();

      expect(
        await thelper.getRun("00000000-0000-0000-0000-000000000000")
      ).toBeNull();
    });
  });

  describe("Event system", () => {
    test("emit and await event with payload", async () => {
      const eventName = randomName("test_event");
      absurd.registerTask({ name: "test-await-event" }, async (params, ctx) => {
        return { received: await ctx.awaitEvent(eventName) };
      });

      const { taskID } = await absurd.spawn("test-await-event", undefined);
      await absurd.workBatch("test-worker-event", 60, 1);

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "sleeping",
      });

      const eventPayload = { eventInput: Math.random() };
      await absurd.emitEvent(eventName, eventPayload);
      await absurd.workBatch("test-worker-event", 60, 1);

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "completed",
        completed_payload: { received: eventPayload },
      });
    });

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
    test("workBatch processes single task", async () => {
      absurd.registerTask<{ value: number }, { doubled: number }>(
        { name: "test-work-batch-single" },
        async (params) => {
          return { doubled: params.value * 2 };
        }
      );

      const { taskID } = await absurd.spawn("test-work-batch-single", {
        value: 5,
      });

      await absurd.workBatch("test-worker-batch", 60, 1);

      expect(await thelper.getTask(taskID)).toMatchObject({
        state: "completed",
        completed_payload: { doubled: 10 },
        attempts: 1,
      });
    });

    test("workBatch processes multiple tasks", async () => {
      absurd.registerTask<{ id: number }, { result: string }>(
        { name: "test-work-batch-multiple" },
        async (params) => {
          return { result: `task-${params.id}` };
        }
      );

      const task1 = await absurd.spawn("test-work-batch-multiple", { id: 1 });
      const task2 = await absurd.spawn("test-work-batch-multiple", { id: 2 });
      const task3 = await absurd.spawn("test-work-batch-multiple", { id: 3 });

      await absurd.workBatch("test-worker-batch-multi", 60, 5);

      expect(await thelper.getTask(task1.taskID)).toMatchObject({
        state: "completed",
        completed_payload: { result: "task-1" },
      });
      expect(await thelper.getTask(task2.taskID)).toMatchObject({
        state: "completed",
        completed_payload: { result: "task-2" },
      });
      expect(await thelper.getTask(task3.taskID)).toMatchObject({
        state: "completed",
        completed_payload: { result: "task-3" },
      });
    });

    test("workBatch handles task failures gracefully", async () => {
      absurd.registerTask<{ shouldFail: boolean }>(
        { name: "test-work-batch-fail", defaultMaxAttempts: 1 },
        async (params) => {
          if (params.shouldFail) {
            throw new Error("Task failed in batch");
          }
          return { success: true };
        }
      );

      const failTask = await absurd.spawn("test-work-batch-fail", {
        shouldFail: true,
      });
      const successTask = await absurd.spawn("test-work-batch-fail", {
        shouldFail: false,
      });

      await absurd.workBatch("test-worker-batch-fail", 60, 2);

      const failedTask = await thelper.getTask(failTask.taskID);
      assert(failedTask);
      expect(failedTask).toMatchObject({
        state: "failed",
      });
      // Get the run to check the failure reason
      assert(failedTask.last_attempt_run);
      const failedRun = await thelper.getRun(failedTask.last_attempt_run);
      expect(failedRun?.failure_reason).toMatchObject({
        message: "Task failed in batch",
      });
      
      expect(await thelper.getTask(successTask.taskID)).toMatchObject({
        state: "completed",
        completed_payload: { success: true },
      });
    });
  });
});
