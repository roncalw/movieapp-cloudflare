import type { Env } from "../shared/types";

type ImportJobLockRow = {
	owner: string;
	lock_expires_at: string;
};

export function createJobOwner(trigger: "manual" | "cron") {
	return `${trigger}-${Date.now()}-${crypto.randomUUID()}`;
}

export async function acquireImportJobLock(
	env: Env,
	jobName: string,
	owner: string,
	lockMinutes: number,
) {
	await env.DB.prepare(
		`DELETE FROM import_job_locks
		 WHERE job_name = ?
		   AND lock_expires_at < CURRENT_TIMESTAMP`,
	).bind(jobName).run();

	const insertResult = await env.DB.prepare(
		`INSERT OR IGNORE INTO import_job_locks (
			 job_name,
			 locked_at,
			 lock_expires_at,
			 owner
		 )
		 VALUES (?, CURRENT_TIMESTAMP, datetime('now', '+' || ? || ' minutes'), ?)`,
	).bind(jobName, lockMinutes, owner).run();

	if (insertResult.meta.changes > 0) {
		console.log(
			JSON.stringify({
				event: "import-job-lock-acquired",
				jobName,
				owner,
				lockMinutes,
			}),
		);
		return true;
	}

	const existingLock = await env.DB.prepare(
		`SELECT owner, lock_expires_at
		 FROM import_job_locks
		 WHERE job_name = ?`,
	).bind(jobName).first<ImportJobLockRow>();

	console.log(
		JSON.stringify({
			event: "import-job-lock-skipped",
			jobName,
			owner,
			existingOwner: existingLock?.owner ?? null,
			existingLockExpiresAt: existingLock?.lock_expires_at ?? null,
		}),
	);

	return false;
}

export async function releaseImportJobLock(
	env: Env,
	jobName: string,
	owner: string,
) {
	await env.DB.prepare(
		`DELETE FROM import_job_locks
		 WHERE job_name = ?
		   AND owner = ?`,
	).bind(jobName, owner).run();

	console.log(
		JSON.stringify({
			event: "import-job-lock-released",
			jobName,
			owner,
		}),
	);
}
