SELECT
  type,
  name,
  tbl_name,
  sql
FROM sqlite_master
WHERE type IN ('table', 'index')
ORDER BY
  type,
  name;
