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
  cleanupTasks(): Promise<void>;
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
    cleanupTasks: () => cleanupTasks(queueName),
  };
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

// Simple test helpers for querying task and run state
export async function getTask(taskID: string, queue: string = 'default') {
  const { rows } = await pool.query(
    `SELECT * FROM absurd.t_${queue} WHERE task_id = $1`,
    [taskID]
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function getRun(runID: string, queue: string = 'default') {
  const { rows } = await pool.query(
    `SELECT * FROM absurd.r_${queue} WHERE run_id = $1`,
    [runID]
  );
  return rows.length > 0 ? rows[0] : null;
}
