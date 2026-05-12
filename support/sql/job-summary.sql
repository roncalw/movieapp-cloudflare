WITH latest AS (
  SELECT *
  FROM movie_list_load_counts
  WHERE pl_counted_at IS NOT NULL
  ORDER BY pl_counted_at DESC
  LIMIT 1
),
previous_current AS (
  SELECT *
  FROM movie_list_load_counts
  WHERE load_date < (SELECT load_date FROM latest)
    AND cc_counted_at IS NOT NULL
  ORDER BY cc_counted_at DESC
  LIMIT 1
),
comparison AS (
  SELECT
    latest.*,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.load_date
      ELSE latest.load_date
    END AS baseline_load_date,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.cc_counted_at
      ELSE latest.cc_counted_at
    END AS baseline_cc_counted_at,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.cc_count
      ELSE latest.cc_count
    END AS baseline_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.imdb_rating_cc_count
      ELSE latest.imdb_rating_cc_count
    END AS baseline_imdb_rating_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.imdb_vote_cc_count
      ELSE latest.imdb_vote_cc_count
    END AS baseline_imdb_vote_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.release_date_cc_count
      ELSE latest.release_date_cc_count
    END AS baseline_release_date_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.certification_cc_count
      ELSE latest.certification_cc_count
    END AS baseline_certification_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.popularity_cc_count
      ELSE latest.popularity_cc_count
    END AS baseline_popularity_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.genre_cc_count
      ELSE latest.genre_cc_count
    END AS baseline_genre_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.genre_per_movie_cc_count
      ELSE latest.genre_per_movie_cc_count
    END AS baseline_genre_per_movie_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.watch_provider_cc_count
      ELSE latest.watch_provider_cc_count
    END AS baseline_watch_provider_cc_count,
    CASE
      WHEN latest.cc_counted_at > latest.pl_counted_at THEN previous_current.watch_provider_per_movie_cc_count
      ELSE latest.watch_provider_per_movie_cc_count
    END AS baseline_watch_provider_per_movie_cc_count
  FROM latest
  LEFT JOIN previous_current
),
fields(sort_order, field_name) AS (
  VALUES
    (1, 'Movie count'),
    (2, 'IMDb rating count'),
    (3, 'IMDb vote count'),
    (4, 'Release date count'),
    (5, 'US certification count'),
    (6, 'Popularity count'),
    (7, 'Genre row count'),
    (8, 'Movies with genres'),
    (9, 'Watch provider row count'),
    (10, 'Movies with watch providers')
),
checks AS (
  SELECT
    fields.sort_order,
    fields.field_name,
    comparison.baseline_cc_counted_at AS cc_counted_at,
    comparison.pl_counted_at AS pc_counted_at,
    CASE fields.field_name
      WHEN 'Movie count' THEN comparison.baseline_cc_count
      WHEN 'IMDb rating count' THEN comparison.baseline_imdb_rating_cc_count
      WHEN 'IMDb vote count' THEN comparison.baseline_imdb_vote_cc_count
      WHEN 'Release date count' THEN comparison.baseline_release_date_cc_count
      WHEN 'US certification count' THEN comparison.baseline_certification_cc_count
      WHEN 'Popularity count' THEN comparison.baseline_popularity_cc_count
      WHEN 'Genre row count' THEN comparison.baseline_genre_cc_count
      WHEN 'Movies with genres' THEN comparison.baseline_genre_per_movie_cc_count
      WHEN 'Watch provider row count' THEN comparison.baseline_watch_provider_cc_count
      WHEN 'Movies with watch providers' THEN comparison.baseline_watch_provider_per_movie_cc_count
    END AS current_count,
    CASE fields.field_name
      WHEN 'Movie count' THEN comparison.pl_count
      WHEN 'IMDb rating count' THEN comparison.imdb_rating_pl_count
      WHEN 'IMDb vote count' THEN comparison.imdb_vote_pl_count
      WHEN 'Release date count' THEN comparison.release_date_pl_count
      WHEN 'US certification count' THEN comparison.certification_pl_count
      WHEN 'Popularity count' THEN comparison.popularity_pl_count
      WHEN 'Genre row count' THEN comparison.genre_pl_count
      WHEN 'Movies with genres' THEN comparison.genre_per_movie_pl_count
      WHEN 'Watch provider row count' THEN comparison.watch_provider_pl_count
      WHEN 'Movies with watch providers' THEN comparison.watch_provider_per_movie_pl_count
    END AS potential_count,
    CASE
      WHEN fields.field_name IN ('Watch provider row count', 'Movies with watch providers')
        THEN comparison.watch_provider_threshold
      ELSE comparison.threshold
    END AS threshold_pct
  FROM comparison
  CROSS JOIN fields
)
SELECT
  field_name AS field,
  current_count,
  cc_counted_at AS "CC date/time",
  potential_count,
  pc_counted_at AS "PC date/time",
  printf('%.2f%%', threshold_pct) AS threshold,
  CASE
    WHEN current_count = 0 THEN 'n/a'
    ELSE printf('%+.2f%%', ((potential_count - current_count) * 100.0 / current_count))
  END AS delta,
  CASE
    WHEN current_count = 0 AND potential_count = 0 THEN 'Passed'
    WHEN current_count = 0 THEN 'Passed, no prior baseline'
    WHEN potential_count = current_count THEN 'Passed, unchanged'
    WHEN potential_count > current_count THEN 'Passed, increased'
    WHEN ((current_count - potential_count) * 100.0 / current_count) <= threshold_pct THEN 'Passed, drop under threshold'
    ELSE 'Failed, drop over threshold'
  END AS result
FROM checks
ORDER BY sort_order;
