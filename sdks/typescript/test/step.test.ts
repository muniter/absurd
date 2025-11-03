import { describe, test, assert, expect, beforeAll, afterEach } from "vitest";
import { createTestAbsurd, randomName, type TestContext } from "./setup.js";
import type { Absurd } from "../src/index.js";

describe("Step functionality", () => {
  let thelper: TestContext;
  let absurd: Absurd;

  beforeAll(async () => {
    const queueName = randomName("test_queue");
    thelper = createTestAbsurd(queueName);
    absurd = thelper.absurd;
    await absurd.createQueue(queueName);
  });

  afterEach(async () => {
    await thelper.cleanupTasks();
  });

  test("step executes and returns value", async () => {
    absurd.registerTask<{ value: number }, { result: string }>(
      { name: "test-step-basic" },
      async (params, ctx) => {
        const result = await ctx.step("process", async () => {
          return `processed-${params.value}`;
        });
        return { result };
      }
    );

    const { taskID } = await absurd.spawn("test-step-basic", { value: 42 });
    await absurd.workBatch(randomName("w"), 60, 1);

    expect(await absurd.getTask(taskID)).toMatchObject({
      status: "completed",
      result: { result: "processed-42" },
    });
  });

  test("step result is cached and not re-executed on retry", async () => {
    let executionCount = 0;
    let attemptCount = 0;

    absurd.registerTask<void, { random: number; count: number }>(
      { name: "test-step-cache", defaultMaxAttempts: 2 },
      async (params, ctx) => {
        attemptCount++;

        const cached = await ctx.step("generate-random", async () => {
          executionCount++;
          return Math.random();
        });

        if (attemptCount === 1) {
          throw new Error("Intentional failure");
        }

        return { random: cached, count: executionCount };
      }
    );

    const { taskID } = await absurd.spawn("test-step-cache", undefined);

    const workerID = randomName("w");
    await absurd.workBatch(workerID, 60, 1);
    expect(executionCount).toBe(1);

    await absurd.workBatch(workerID, 60, 1);
    expect(executionCount).toBe(1);
    expect(attemptCount).toBe(2);

    expect(await absurd.getTask(taskID)).toMatchObject({
      status: "completed",
      result: { count: 1 },
      attempts: 2,
    });
  });

  test("task with multiple steps only re-executes uncompleted steps on retry", async () => {
    const executed: string[] = [];
    let attemptCount = 0;

    absurd.registerTask<void, { steps: string[]; attemptNum: number }>(
      { name: "test-multi-step-retry", defaultMaxAttempts: 2 },
      async (params, ctx) => {
        attemptCount++;

        const step1 = await ctx.step("step1", async () => {
          executed.push("step1");
          return "result1";
        });

        const step2 = await ctx.step("step2", async () => {
          executed.push("step2");
          return "result2";
        });

        if (attemptCount === 1) {
          throw new Error("Fail before step3");
        }

        const step3 = await ctx.step("step3", async () => {
          executed.push("step3");
          return "result3";
        });

        return { steps: [step1, step2, step3], attemptNum: attemptCount };
      }
    );

    const { taskID } = await absurd.spawn("test-multi-step-retry", undefined);

    const workerID = randomName("w");
    await absurd.workBatch(workerID, 60, 1);
    expect(executed).toEqual(["step1", "step2"]);

    await absurd.workBatch(workerID, 60, 1);
    expect(executed).toEqual(["step1", "step2", "step3"]);

    expect(await absurd.getTask(taskID)).toMatchObject({
      status: "completed",
      result: { steps: ["result1", "result2", "result3"], attemptNum: 2 },
      attempts: 2,
    });

    const checkpoints = await thelper.getCheckpoints(taskID);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((c) => c.step_name)).toEqual([
      "step1",
      "step2",
      "step3",
    ]);
  });

  test("repeated step names get unique checkpoint names", async () => {
    absurd.registerTask<void, { results: number[] }>(
      { name: "test-step-dedup" },
      async (params, ctx) => {
        const results: number[] = [];
        for (let i = 0; i < 3; i++) {
          const result = await ctx.step("loop-step", async () => {
            return i * 10;
          });
          results.push(result);
        }
        return { results };
      }
    );

    const { taskID } = await absurd.spawn("test-step-dedup", undefined);
    await absurd.workBatch(randomName("w"), 60, 1);

    expect(await absurd.getTask(taskID)).toMatchObject({
      status: "completed",
      result: { results: [0, 10, 20] },
    });

    const checkpoints = await thelper.getCheckpoints(taskID);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((c) => c.step_name)).toEqual([
      "loop-step",
      "loop-step#2",
      "loop-step#3",
    ]);
  });

  test("failed step does not save checkpoint and re-executes on retry", async () => {
    let attemptCount = 0;

    absurd.registerTask<void, { result: string }>(
      { name: "test-step-failure", defaultMaxAttempts: 2 },
      async (params, ctx) => {
        const result = await ctx.step("failing-step", async () => {
          attemptCount++;
          if (attemptCount === 1) {
            throw new Error("Step fails on first attempt");
          }
          return "success";
        });

        return { result };
      }
    );

    const { taskID } = await absurd.spawn("test-step-failure", undefined);

    const workerID = randomName("w");
    await absurd.workBatch(workerID, 60, 1);
    expect(attemptCount).toBe(1);

    const checkpointsAfterFailure = await thelper.getCheckpoints(taskID);
    expect(checkpointsAfterFailure).toHaveLength(0);

    await absurd.workBatch(workerID, 60, 1);
    expect(attemptCount).toBe(2);

    expect(await absurd.getTask(taskID)).toMatchObject({
      status: "completed",
      result: { result: "success" },
      attempts: 2,
    });

    const checkpointsAfterSuccess = await thelper.getCheckpoints(taskID);
    expect(checkpointsAfterSuccess).toHaveLength(1);
    expect(checkpointsAfterSuccess[0]?.state).toBe("success");
  });
});
