SELECT
  tmdb.tmdb_id,
  tmdb.title,
  tmdb.poster_path,
  tmdb.release_date,
  tmdb.us_certification,
  imdb.average_rating AS imdb_rating,
  imdb.num_votes AS imdb_vote_count,
  tmdb.popularity
FROM tmdb_movies_staging AS tmdb
LEFT JOIN imdb_ratings_staging AS imdb
  ON imdb.imdb_id = tmdb.imdb_id
WHERE tmdb.tmdb_enriched_at IS NOT NULL
  AND tmdb.tmdb_enrichment_error IS NULL
ORDER BY
  tmdb.release_date DESC,
  tmdb.popularity DESC,
  tmdb.tmdb_id
LIMIT 50;
