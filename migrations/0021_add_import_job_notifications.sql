-- Migration number: 0021
--
-- Track best-effort completion email delivery separately from job success.
-- Import jobs should not fail just because the notification channel is not
-- configured yet or an email send attempt fails.
ALTER TABLE import_job_runs ADD COLUMN notification_sent_at TEXT;
ALTER TABLE import_job_runs ADD COLUMN notification_error TEXT;
