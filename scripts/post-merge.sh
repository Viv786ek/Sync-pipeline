#!/bin/bash
# Post-merge setup: install deps and push DB schema changes.
# Run this after pulling new commits that include schema changes.
set -e

pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push
