-- Migration number: 0001 	 2026-04-22T19:49:57.832Z
-- Create the movies table if it does not already exist.
--
-- IF NOT EXISTS means:
-- if the table is already there, do not crash with an error.
--
-- id INTEGER PRIMARY KEY AUTOINCREMENT means:
-- SQLite/D1 will automatically assign the next id number
-- whenever you insert a row without providing id yourself.
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  MovieName TEXT NOT NULL,
  IMDBRating REAL NOT NULL,
  IMDBVoteCounts INTEGER NOT NULL
);
