import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	continueIndependentProviderAvailabilityCycle,
	finalizeProviderAvailabilityCycleForCacheRun,
} from "../src/jobs/providerAvailabilityCycle";
import type { Env } from "../src/shared/types";

const PROVIDER_REFRESH_JOB_RUN_ID = "tmdb-provider-refresh-cron-test-cycle";

async function resetProviderCycleTables() {
	/*
		This test uses the local, isolated D1 database supplied by the Cloudflare
		test runner. Only the columns exercised by the provider cycle are required.
		Using real SQLite statements here verifies the delete-and-replace transaction,
		the exact job-run links, and the JSON-backed cache source together.
	*/
	await testEnv.DB.batch([
		testEnv.DB.prepare("DROP TABLE IF EXISTS import_job_locks"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS import_job_runs"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS movie_watch_providers_staging"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS movie_watch_providers"),
		testEnv.DB.prepare(`CREATE TABLE import_job_locks (
			job_name TEXT PRIMARY KEY,
			locked_at TEXT NOT NULL,
			lock_expires_at TEXT NOT NULL,
			owner TEXT NOT NULL
		)`),
		testEnv.DB.prepare(`CREATE TABLE import_job_runs (
			job_run_id TEXT PRIMARY KEY,
			job_name TEXT NOT NULL,
			status TEXT NOT NULL,
			trigger TEXT NOT NULL,
			selected_count INTEGER NOT NULL DEFAULT 0,
			queued_count INTEGER NOT NULL DEFAULT 0,
			processed_count INTEGER NOT NULL DEFAULT 0,
			updated_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			provider_rows_inserted INTEGER NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			last_progress_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			ended_at TEXT,
			last_error TEXT,
			result_json TEXT,
			notification_sent_at TEXT,
			notification_error TEXT
		)`),
		testEnv.DB.prepare(`CREATE INDEX idx_import_job_runs_job_status
			ON import_job_runs (job_name, status, started_at)`),
		testEnv.DB.prepare(`CREATE TABLE movie_watch_providers_staging (
			tmdb_id INTEGER NOT NULL,
			provider_id INTEGER,
			region TEXT NOT NULL,
			load_run_id TEXT NOT NULL,
			is_full_refresh INTEGER NOT NULL DEFAULT 0,
			staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			promoted_at TEXT,
			PRIMARY KEY (tmdb_id, provider_id, region)
		)`),
		testEnv.DB.prepare(`CREATE TABLE movie_watch_providers (
			tmdb_id INTEGER NOT NULL,
			provider_id INTEGER NOT NULL,
			region TEXT NOT NULL,
			promotion_run_id TEXT,
			promoted_at TEXT,
			PRIMARY KEY (tmdb_id, provider_id, region)
		)`),
	]);
}

describe("independent provider availability cycle", () => {
	beforeEach(async () => {
		await resetProviderCycleTables();
	});

	it("applies one exact refresh, queues its cache warm, and validates completion", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: testEnv.DB,
			CACHE_WARM_QUEUE: { sendBatch },
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
		} as unknown as Env;

		await testEnv.DB.prepare(
			`INSERT INTO import_job_runs (
				job_run_id,
				job_name,
				status,
				trigger,
				selected_count,
				queued_count,
				processed_count,
				error_count,
				ended_at,
				result_json
			 ) VALUES (?, 'tmdb-provider-refresh', 'complete', 'cron', 2, 2, 2, 0, CURRENT_TIMESTAMP, '{}')`,
		)
			.bind(PROVIDER_REFRESH_JOB_RUN_ID)
			.run();

		await testEnv.DB.prepare(
			`INSERT INTO movie_watch_providers (
				tmdb_id, provider_id, region, promotion_run_id, promoted_at
			 ) VALUES (999, 999, 'US', 'previous-provider-apply', CURRENT_TIMESTAMP)`,
		).run();

		await testEnv.DB.prepare(
			`INSERT INTO movie_watch_providers_staging (
				tmdb_id, provider_id, region, load_run_id, is_full_refresh
			) VALUES
				(101, 10, 'US', ?, 1),
				(101, 11, 'US', ?, 1),
				(202, -1, 'US', ?, 1)`,
		)
			.bind(
				PROVIDER_REFRESH_JOB_RUN_ID,
				PROVIDER_REFRESH_JOB_RUN_ID,
				PROVIDER_REFRESH_JOB_RUN_ID,
			)
			.run();

		const started = await continueIndependentProviderAvailabilityCycle(
			env,
			PROVIDER_REFRESH_JOB_RUN_ID,
		);

		expect(started).toMatchObject({
			started: true,
			providerRefreshJobRunId: PROVIDER_REFRESH_JOB_RUN_ID,
		});
		expect(sendBatch).toHaveBeenCalled();

		const { results: liveRows } = await testEnv.DB.prepare(
			`SELECT tmdb_id, provider_id, promotion_run_id
			 FROM movie_watch_providers
			 ORDER BY tmdb_id, provider_id`,
		).all<{
			tmdb_id: number;
			provider_id: number;
			promotion_run_id: string;
		}>();

		expect(liveRows).toEqual([
			{
				tmdb_id: 101,
				provider_id: 10,
				promotion_run_id: started.providerPromotionJobRunId,
			},
			{
				tmdb_id: 101,
				provider_id: 11,
				promotion_run_id: started.providerPromotionJobRunId,
			},
			{
				tmdb_id: 202,
				provider_id: -1,
				promotion_run_id: started.providerPromotionJobRunId,
			},
		]);

		const cacheRun = await testEnv.DB.prepare(
			`SELECT job_run_id, status, selected_count, result_json
			 FROM import_job_runs
			 WHERE job_run_id = ?`,
		)
			.bind(started.cacheWarmJobRunId)
			.first<{
				job_run_id: string;
				status: string;
				selected_count: number;
				result_json: string;
			}>();
		const cacheResult = JSON.parse(cacheRun?.result_json ?? "{}") as Record<
			string,
			unknown
		>;

		expect(cacheRun?.status).toBe("queued");
		expect(cacheResult).toMatchObject({
			sourceKind: "provider-refresh",
			providerRefreshJobRunId: PROVIDER_REFRESH_JOB_RUN_ID,
			providerPromotionJobRunId: started.providerPromotionJobRunId,
		});

		await testEnv.DB.prepare(
			`UPDATE import_job_runs
			 SET status = 'complete',
			     processed_count = selected_count,
			     error_count = 0,
			     ended_at = CURRENT_TIMESTAMP
			 WHERE job_run_id = ?`,
		)
			.bind(started.cacheWarmJobRunId)
			.run();

		await finalizeProviderAvailabilityCycleForCacheRun(
			env,
			started.cacheWarmJobRunId as string,
		);

		const validation = await testEnv.DB.prepare(
			`SELECT status, error_count, result_json
			 FROM import_job_runs
			 WHERE job_name = 'provider-availability-validation'`,
		).first<{
			status: string;
			error_count: number;
			result_json: string;
		}>();
		const validationResult = JSON.parse(
			validation?.result_json ?? "{}",
		) as Record<string, unknown>;
		const remainingLocks = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM import_job_locks",
		).first<{ count: number }>();

		expect(validation?.status).toBe("complete");
		expect(validation?.error_count).toBe(0);
		expect(validationResult).toMatchObject({
			providerRefreshJobRunId: PROVIDER_REFRESH_JOB_RUN_ID,
			providerPromotionJobRunId: started.providerPromotionJobRunId,
			cacheWarmJobRunId: started.cacheWarmJobRunId,
			issueCount: 0,
		});
		expect(remainingLocks?.count).toBe(0);
	});

	it("records a failed refresh without changing live providers or warming cache", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: testEnv.DB,
			CACHE_WARM_QUEUE: { sendBatch },
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
		} as unknown as Env;

		await testEnv.DB.prepare(
			`INSERT INTO import_job_runs (
				job_run_id,
				job_name,
				status,
				trigger,
				selected_count,
				queued_count,
				processed_count,
				error_count,
				ended_at,
				last_error,
				result_json
			 ) VALUES (?, 'tmdb-provider-refresh', 'failed', 'cron', 2, 2, 1, 1, CURRENT_TIMESTAMP, 'provider request failed', '{}')`,
		)
			.bind(PROVIDER_REFRESH_JOB_RUN_ID)
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO movie_watch_providers (
				tmdb_id, provider_id, region, promotion_run_id, promoted_at
			 ) VALUES (999, 999, 'US', 'last-good-provider-apply', CURRENT_TIMESTAMP)`,
		).run();

		const result = await continueIndependentProviderAvailabilityCycle(
			env,
			PROVIDER_REFRESH_JOB_RUN_ID,
		);
		const liveRow = await testEnv.DB.prepare(
			`SELECT tmdb_id, provider_id, promotion_run_id
			 FROM movie_watch_providers`,
		).first<{
			tmdb_id: number;
			provider_id: number;
			promotion_run_id: string;
		}>();
		const validation = await testEnv.DB.prepare(
			`SELECT status, error_count
			 FROM import_job_runs
			 WHERE job_name = 'provider-availability-validation'`,
		).first<{ status: string; error_count: number }>();
		const downstreamCount = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS count
			 FROM import_job_runs
			 WHERE job_name IN ('movie-watch-providers-promote', 'cache-warm-search')`,
		).first<{ count: number }>();

		expect(result).toEqual({
			started: false,
			reason: "provider_refresh_not_successful",
		});
		expect(liveRow).toEqual({
			tmdb_id: 999,
			provider_id: 999,
			promotion_run_id: "last-good-provider-apply",
		});
		expect(validation).toEqual({ status: "failed", error_count: 4 });
		expect(downstreamCount?.count).toBe(0);
		expect(sendBatch).not.toHaveBeenCalled();
	});
});
