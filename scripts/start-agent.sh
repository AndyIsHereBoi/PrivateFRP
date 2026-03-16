#!/bin/bash
set -e
cd "$(dirname "$0")/.."
docker compose -f docker-compose.agent.yml --env-file agent.env up --build
