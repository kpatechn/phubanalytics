#!/usr/bin/env bash
# Builds the dashboard image (Dockerfile at the repo root: API + web app) for linux/arm64 and pushes
# it to the environment's ECR repository, tagged with the commit's short sha (tags are immutable).
# Then set image_tag in the data platform's infra/terraform/dashboard/envs/<env>.tfvars and apply,
# or run its dashboard.sh on.
#
# Usage: scripts/push-dashboard-image.sh [env]        (default dev; AWS profile playerhub-<env>)
# Builds only from a clean working tree, so the tag names exactly what is inside.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-dev}"
export AWS_PROFILE="${AWS_PROFILE:-playerhub-$ENV_NAME}" AWS_REGION="${AWS_REGION:-us-west-2}"
cd "$ROOT"

if [ -n "$(git status --porcelain -- apps packages package.json package-lock.json Dockerfile .dockerignore)" ]; then
  echo "Commit the dashboard changes first: the image tag is the commit." >&2
  exit 1
fi
tag="$(git rev-parse --short HEAD)"
account="$(aws sts get-caller-identity --query Account --output text)"
registry="$account.dkr.ecr.$AWS_REGION.amazonaws.com"
image="$registry/playerhub-$ENV_NAME-dashboard:$tag"

if aws ecr describe-images --repository-name "playerhub-$ENV_NAME-dashboard" --image-ids "imageTag=$tag" >/dev/null 2>&1; then
  echo "Already pushed: $image"
else
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker buildx build --platform linux/arm64 --provenance=false -t "$image" --push .
  echo "Pushed: $image"
fi
echo "Next: image_tag = \"$tag\" in infra/terraform/dashboard/envs/$ENV_NAME.tfvars (data platform), then apply."
