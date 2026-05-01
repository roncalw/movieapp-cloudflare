#!/usr/bin/env zsh

# Run one saved SQL support script against the local Wrangler D1 database.
#
# This file exists so VS Code tasks can stay short and readable.
# Instead of putting a long SQL statement directly in .vscode/tasks.json,
# each task passes the path to a .sql file here.
#
# Examples:
#   zsh support/run-sql-local.sh support/sql/tmdb-counts.sql
#   zsh support/run-sql-local.sh support/sql/movie-search-by-year.sql START_DATE=2020-01-01 END_DATE=2020-12-31
#
# Parameter:
#   $1
#     The path to the SQL file to run. This is required.
#     Example: support/sql/tmdb-counts.sql
#
#   $2, $3, ...
#     Optional SQL token values written as TOKEN=value.
#     Example: START_DATE=2020-01-01
#
#     If the SQL file contains:
#       '__START_DATE__'
#
#     and the task passes:
#       START_DATE=2020-01-01
#
#     then this helper changes that SQL text to:
#       '2020-01-01'
#
# Why this uses --command instead of --file:
#   Wrangler's remote --file mode is mainly shaped like an import flow and can
#   return an execution summary instead of the SELECT result rows we want to see.
#   To keep local and remote tasks behaving the same way, this helper reads the
#   SQL file with cat and passes the SQL text into Wrangler's --command option.
#
# Why this script uses --local:
#   --local tells Wrangler to run the SQL against the local development D1
#   database stored under .wrangler/state/v3/d1. It does not touch the remote
#   Cloudflare database.
#
# What the final command means:
#   npx
#     Runs the project-local Wrangler package from node_modules.
#
#   wrangler d1 execute movieapp-db
#     Tells Wrangler to execute SQL against the configured D1 database named
#     movieapp-db from wrangler.jsonc.
#
#   --local
#     Uses the local development database instead of Cloudflare's remote D1.
#
#   --command="$(cat "$sql_file")"
#     Reads the selected .sql file and sends its contents as the SQL command.
#     The equals sign keeps --command and the SQL text together as one CLI
#     argument. That matters when a SQL file starts with a comment like
#     "-- comment", because otherwise Wrangler can mistake the SQL comment for
#     a command-line option.
#
set -euo pipefail

# Stop on common shell mistakes:
#
#   -e
#     Exit immediately if a command fails.
#     Example: if Wrangler fails, stop the script instead of continuing as if
#     the SQL ran successfully.
#
#   -u
#     Exit if the script tries to use a variable that was never set.
#     Example: if sql_file was missing by mistake, do not continue with an
#     empty file path.
#
#   -o pipefail
#     Exit if any command inside a pipeline fails.
#     Example: in a command shaped like "first-command | second-command",
#     some shells only care whether second-command worked. pipefail makes the
#     whole pipeline fail if first-command failed too.

if [[ $# -lt 1 ]]; then
  # This script needs at least one argument: the SQL file path.
  # After that, it can also receive optional TOKEN=value arguments.
  #
  #   $#
  #     The number of arguments passed to this script.
  #
  #   -lt
  #     Numeric "less than".
  #
  #   [[ $# -lt 1 ]]
  #     Means "if the number of arguments is less than 1".
  #
  # Valid:
  #   zsh support/run-sql-local.sh support/sql/tmdb-counts.sql
  #   zsh support/run-sql-local.sh support/sql/movie-search-by-year.sql START_DATE=2020-01-01 END_DATE=2020-12-31
  #
  # Invalid:
  #   zsh support/run-sql-local.sh
  #
  #   >&2
  #     Print the usage message to stderr, which is the normal output stream
  #     for error messages.
  #
  #   exit 1
  #     Stop the script and report failure.
  echo "Usage: support/run-sql-local.sh support/sql/query-name.sql [TOKEN=value ...]" >&2
  exit 1
fi

# Store the first argument in a readable variable name.
sql_file="$1"
shift

if [[ ! -f "$sql_file" ]]; then
  # Fail early with a clear message if the task points at a missing file.
  echo "SQL file not found: $sql_file" >&2
  exit 1
fi

# Read the SQL file into memory so optional TOKEN=value arguments can replace
# tokens like __START_DATE__ before Wrangler receives the SQL.
sql_text="$(cat "$sql_file")"

for parameter in "$@"; do
  if [[ "$parameter" != *=* ]]; then
    echo "Invalid parameter: $parameter" >&2
    echo "Expected TOKEN=value, for example START_DATE=2020-01-01" >&2
    exit 1
  fi

  parameter_name="${parameter%%=*}"
  parameter_value="${parameter#*=}"

  if [[ ! "$parameter_name" =~ '^[A-Z][A-Z0-9_]*$' ]]; then
    echo "Invalid parameter name: $parameter_name" >&2
    echo "Use uppercase names like START_DATE or END_DATE." >&2
    exit 1
  fi

  if [[ "$parameter_name" == *DATE && ! "$parameter_value" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]]; then
    echo "Invalid date for $parameter_name: $parameter_value" >&2
    echo "Use YYYY-MM-DD, for example 2020-01-01." >&2
    exit 1
  fi

  token="__${parameter_name}__"
  sql_text="${sql_text//$token/$parameter_value}"
done

# Run the saved SQL against local D1 and print the result in the VS Code terminal.
npx wrangler d1 execute movieapp-db --local --command="$sql_text"
