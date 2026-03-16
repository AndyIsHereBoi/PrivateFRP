#!/bin/bash
set -e
cd "$(dirname "$0")/.."
git reset --hard HEAD
git pull
docker compose -f docker-compose.yml --env-file server.env up --build
