import { afterAll, beforeAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Absurd } from '../src/index.js';

// Global container and pool instances
export let container: StartedPostgreSqlContainer;
export let pool: Pool;

// Setup container once before all tests
beforeAll(async () => {
  console.time('Test container startup');
  // Start PostgreSQL container
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .start();
  console.timeEnd('Test container startup');

  // Create single shared pool with max: 1 connection
  // This ensures SET absurd.fake_now applies to all queries
  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 1, // Critical: single connection for fake_now consistency
  });

  // Load and execute absurd.sql schema
  const schemaPath = join(__dirname, '../../../sql/absurd.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);

  console.log('✓ Test container started and schema loaded');
}, 60000); // 60s timeout for container startup

// Cleanup after all tests
afterAll(async () => {
  console.time('Test container cleanup');
  if (pool) {
    await pool.end();
  }
  if (container) {
    await container.stop();
  }
  console.timeEnd('Test container cleanup');
});

// Test context with Absurd instance and helper functions
export interface TestContext {
  absurd: Absurd;
  pool: typeof pool;
  queueName: string;

  // Helper functions
  getTaskState(taskID: string): Promise<TaskState | null>;
  getCheckpoints(taskID: string): Promise<Checkpoint[]>;
  getRuns(taskID: string): Promise<Run[]>;
  waitForTask(taskID: string, timeout?: number): Promise<TaskState>;
  advanceTime(seconds: number): Promise<void>;
  resetTime(): Promise<void>;
  cleanupTasks(): Promise<void>;
}

// Helper: Generate random name for test isolation
export function randomName(prefix = 'test'): string {
  return `${prefix}_${Math.random().toString(36).substring(7)}`;
}

// Helper: Create test context with Absurd instance and all helpers
export function createTestAbsurd(queueName: string = 'default'): TestContext {
  const absurd = new Absurd(pool, queueName);

  return {
    absurd,
    pool,
    queueName,

    // Bind queue name to helper functions
    getTaskState: (taskID: string) => getTaskState(queueName, taskID),
    getCheckpoints: (taskID: string) => getCheckpoints(queueName, taskID),
    getRuns: (taskID: string) => getRuns(queueName, taskID),
    waitForTask: (taskID: string, timeout?: number) => waitForTask(queueName, taskID, timeout),
    advanceTime: (seconds: number) => advanceTime(seconds),
    resetTime: () => resetTime(),
    cleanupTasks: () => cleanupTasks(queueName),
  };
}

// Helper: Get task state from database
export interface TaskState {
  task_id: string;
  state: 'pending' | 'running' | 'sleeping' | 'completed' | 'failed' | 'cancelled';
  completed_payload?: any;
  attempts: number;
  first_started_at?: Date;
  cancelled_at?: Date;
}

export async function getTaskState(
  queue: string,
  taskID: string
): Promise<TaskState | null> {
  const result = await pool.query(
    `SELECT
      task_id,
      state,
      completed_payload,
      attempts,
      first_started_at,
      cancelled_at
    FROM absurd.t_${queue}
    WHERE task_id = $1`,
    [taskID]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    task_id: row.task_id,
    state: row.state,
    completed_payload: row.completed_payload,
    attempts: row.attempts,
    first_started_at: row.first_started_at,
    cancelled_at: row.cancelled_at,
  };
}

// Helper: Get checkpoint states for a task
export interface Checkpoint {
  step_name: string;
  state: any;
  owner_run_id: string;
  created_at: Date;
}

export async function getCheckpoints(
  queue: string,
  taskID: string
): Promise<Checkpoint[]> {
  const result = await pool.query(
    `SELECT checkpoint_name as step_name, state, owner_run_id, updated_at as created_at
    FROM absurd.c_${queue}
    WHERE task_id = $1
    ORDER BY updated_at ASC`,
    [taskID]
  );

  return result.rows.map(row => ({
    step_name: row.step_name,
    state: row.state,
    owner_run_id: row.owner_run_id,
    created_at: row.created_at,
  }));
}

// Helper: Get runs for a task
export interface Run {
  run_id: string;
  attempt: number;
  state: 'pending' | 'running' | 'sleeping' | 'completed' | 'failed';
  claimed_by?: string;
  claim_expires_at?: Date;
  completed_at?: Date;
  failed_at?: Date;
  failure_reason?: any;
}

export async function getRuns(queue: string, taskID: string): Promise<Run[]> {
  const result = await pool.query(
    `SELECT
      run_id,
      attempt,
      state,
      claimed_by,
      claim_expires_at,
      completed_at,
      failed_at,
      failure_reason
    FROM absurd.r_${queue}
    WHERE task_id = $1
    ORDER BY attempt ASC`,
    [taskID]
  );

  return result.rows.map(row => ({
    run_id: row.run_id,
    attempt: row.attempt,
    state: row.state,
    claimed_by: row.claimed_by,
    claim_expires_at: row.claim_expires_at,
    completed_at: row.completed_at,
    failed_at: row.failed_at,
    failure_reason: row.failure_reason ? JSON.parse(row.failure_reason) : undefined,
  }));
}

// Helper: Wait for task to reach terminal state
export async function waitForTask(
  queue: string,
  taskID: string,
  timeout: number = 10000
): Promise<TaskState> {
  const startTime = Date.now();
  const pollInterval = 100; // 100ms

  while (Date.now() - startTime < timeout) {
    const state = await getTaskState(queue, taskID);

    if (!state) {
      throw new Error(`Task ${taskID} not found`);
    }

    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      return state;
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  const finalState = await getTaskState(queue, taskID);
  throw new Error(
    `Task ${taskID} did not reach terminal state within ${timeout}ms. Current state: ${finalState?.state}`
  );
}

// Helper: Advance time using fake_now
export async function advanceTime(seconds: number): Promise<void> {
  const result = await pool.query(
    `SELECT COALESCE(current_setting('absurd.fake_now', true), '')::text as fake_now`
  );

  const currentFakeNow = result.rows[0].fake_now;

  let baseTime: Date;
  if (currentFakeNow && currentFakeNow !== '') {
    baseTime = new Date(currentFakeNow);
  } else {
    baseTime = new Date();
  }

  const newTime = new Date(baseTime.getTime() + seconds * 1000);
  await pool.query(`SET absurd.fake_now = $1`, [newTime.toISOString()]);
}

// Helper: Reset fake_now
export async function resetTime(): Promise<void> {
  await pool.query(`RESET absurd.fake_now`);
}

// Helper: Create a queue for testing
export async function createQueue(queueName: string): Promise<void> {
  await pool.query(`SELECT absurd.create_queue($1)`, [queueName]);
}

// Helper: Drop a queue
export async function dropQueue(queueName: string): Promise<void> {
  await pool.query(`SELECT absurd.drop_queue($1)`, [queueName]);
}

// Helper: Clean up tasks in a queue
export async function cleanupTasks(queue: string): Promise<void> {
  try {
    await pool.query(`TRUNCATE absurd.t_${queue}, absurd.r_${queue}, absurd.c_${queue}, absurd.e_${queue}, absurd.w_${queue}`);
  } catch (err: any) {
    // Ignore errors if tables don't exist yet (queue not created)
    if (!err.message?.includes('does not exist')) {
      throw err;
    }
  }
}
