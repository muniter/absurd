import { afterAll, beforeAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Absurd } from '../src/index.js';

export let container: StartedPostgreSqlContainer;
export let pool: Pool;

beforeAll(async () => {
  console.time('Test container startup');
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .start();
  console.timeEnd('Test container startup');

  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 1,
  });

  const schemaPath = join(__dirname, '../../../sql/absurd.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);

  console.log('✓ Test container started and schema loaded');
}, 60000);

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

export interface TestContext {
  absurd: Absurd;
  pool: typeof pool;
  queueName: string;
  getCheckpoints(taskID: string): Promise<Checkpoint[]>;
  cleanupTasks(): Promise<void>;
}

export interface Checkpoint {
  step_name: string;
  state: any;
  owner_run_id: string;
  created_at: Date;
}

export function randomName(prefix = 'test'): string {
  return `${prefix}_${Math.random().toString(36).substring(7)}`;
}

export function createTestAbsurd(queueName: string = 'default'): TestContext {
  const absurd = new Absurd(pool, queueName);

  return {
    absurd,
    pool,
    queueName,
    getCheckpoints: (taskID: string) => getCheckpoints(queueName, taskID),
    cleanupTasks: () => cleanupTasks(queueName),
  };
}

async function getCheckpoints(queue: string, taskID: string): Promise<Checkpoint[]> {
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

async function cleanupTasks(queue: string): Promise<void> {
  try {
    await pool.query(`TRUNCATE absurd.t_${queue}, absurd.r_${queue}, absurd.c_${queue}, absurd.e_${queue}, absurd.w_${queue}`);
  } catch (err: any) {
    if (!err.message?.includes('does not exist')) {
      throw err;
    }
  }
}
