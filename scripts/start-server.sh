#!/bin/bash
set -e
cd "$(dirname "$0")/.."
docker compose -f docker-compose.yml --env-file server.env up --build
