#!/usr/bin/env bash
# Starts the three databases the plugin's live integration tests expect, and loads
# their fixtures. Idempotent: re-running reloads the fixtures into containers that
# are already up.
#
#   packages/jetbrains/tools/demo-stack/up.sh
#   cd packages/jetbrains && ./gradlew test -PintegrationTests=true
#
# The ports are deliberately shifted (55432/53306/57017) so this stack never
# collides with a Postgres, MySQL or MongoDB you already run locally.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

start() { # name, then the docker run arguments
  local name=$1; shift
  if [ -n "$(docker ps -q -f "name=^${name}$")" ]; then
    echo "· ${name} already running"
  elif [ -n "$(docker ps -aq -f "name=^${name}$")" ]; then
    docker start "$name" >/dev/null && echo "· ${name} restarted"
  else
    docker run -d --name "$name" "$@" >/dev/null && echo "· ${name} created"
  fi
}

start asksql-demo-pg -p 55432:5432 \
  -e POSTGRES_USER=asksql -e POSTGRES_DB=asksql_demo \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
start asksql-demo-mysql -p 53306:3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=asksql_demo mysql:8.4
start asksql-demo-mongo -p 57017:27017 mongo:7

# MySQL answers on its socket during entrypoint init, before asksql_demo exists;
# "port: 3306" in the log is the first moment the real server is listening.
echo "· waiting for the servers to accept connections"
until docker exec asksql-demo-pg pg_isready -q -U asksql 2>/dev/null; do sleep 2; done
until docker logs asksql-demo-mysql 2>&1 | grep -q "port: 3306"; do sleep 2; done
until docker exec asksql-demo-mongo mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; do sleep 2; done

echo "· loading fixtures"
docker exec -i asksql-demo-pg psql -v ON_ERROR_STOP=1 -U asksql -d asksql_demo < "$HERE/postgres.sql" >/dev/null
docker exec -i asksql-demo-mysql mysql -uroot < "$HERE/mysql.sql"
docker exec -i asksql-demo-mongo mongosh "mongodb://localhost:27017/asksql_demo" --quiet > /dev/null < "$HERE/mongo.js"

echo
echo "demo stack ready. The live tests also need Ollama with these models:"
echo "  qwen2.5-coder:7b   qwen2.5:14b-instruct   qwen2.5-coder:14b-instruct"
echo "Tear down with: docker rm -f asksql-demo-pg asksql-demo-mysql asksql-demo-mongo"
