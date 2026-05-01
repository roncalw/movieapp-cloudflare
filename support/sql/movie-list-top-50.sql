SELECT
  tmdb_id,
  title,
  release_date,
  us_certification,
  imdb_rating,
  imdb_vote_count,
  popularity,
  last_refreshed_at
FROM movie_list_items
ORDER BY
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id
LIMIT 50;
