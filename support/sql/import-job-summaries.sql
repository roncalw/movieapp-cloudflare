SELECT
    --ijr.job_run_id ,
    ijr.job_name,
    ijr.status,
    ijr.trigger,
    ijr.selected_count,
    ijr.queued_count,
    ijr.processed_count,
    ijr.updated_count,
    ijr.error_count,
    ijr.provider_rows_inserted,
    ijr.started_at,
    --ijr.last_progress_at,
    ijr.ended_at,
    ijr.last_error
FROM
`import_job_runs` ijr
order by ended_at desc 
LIMIT 50