set dotenv-load

default_region := "us-east-1"
aws_account := env("AWS_ACCOUNT", "735853783919")
aws_region := env("AWS_REGION", default_region)

check:
    bun run check

test:
    bun test

bench *ARGS:
    bun run src/run.ts {{ARGS}}

smoke:
    bun run src/run.ts --smoke

clean:
    #!/usr/bin/env bash
    set -euo pipefail
    for engine in redis valkey dragonfly; do
        project="kv-${engine}"
        compose_file="compose/docker-compose.${engine}.yml"
        if [ -f "$compose_file" ]; then
            docker compose -f "$compose_file" -p "$project" down -v --remove-orphans 2>/dev/null || true
        fi
    done
    echo "cleaned up all kv-bench containers"

import RESULTS="results.json":
    bun run src/import.ts --results={{RESULTS}}

import-run RESULTS METADATA:
    bun run src/import-run.ts --results={{RESULTS}} --metadata={{METADATA}}

rig-deploy:
    cd infra && bun x cdk deploy --require-approval never --outputs-file ../infra-outputs.json

rig-cloud *ARGS:
    gh workflow run kv-bench-cloud.yml {{ARGS}}

rig-watch:
    gh run list --workflow=kv-bench-cloud.yml --limit=1 --json databaseId --jq '.[0].databaseId' | xargs gh run watch

rig-results:
    #!/usr/bin/env bash
    set -euo pipefail
    BUCKET=$(cd infra && bun x cdk context 2>/dev/null | grep -o 'warefeats-kv-bench-results-[a-z0-9]*' || echo "check infra-outputs.json")
    aws s3 ls "s3://${BUCKET}/" --recursive --human-readable

rig-destroy:
    cd infra && bun x cdk destroy --force

setup-oidc:
    #!/usr/bin/env bash
    set -euo pipefail

    REPO_ID=$(gh api repos/warefeats/kv-stores --jq '.id')
    echo "repo id: ${REPO_ID}"

    GITHUB_ORG_ID="${GITHUB_ORG_ID:-322872963}"

    aws cloudformation deploy \
        --template-file infra/github-oidc-role.yml \
        --stack-name kv-stores-github-oidc \
        --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
        --parameter-overrides \
            GitHubOrganization=warefeats \
            GitHubRepository=kv-stores \
            RepositoryId="${REPO_ID}" \
            OrgId="${GITHUB_ORG_ID}" \
        --region {{aws_region}}

    ROLE_ARN=$(aws cloudformation describe-stacks \
        --stack-name kv-stores-github-oidc \
        --query 'Stacks[0].Outputs[?OutputKey==`RoleArn`].OutputValue' \
        --output text \
        --region {{aws_region}})
    echo "role ARN: ${ROLE_ARN}"

    gh secret set AWS_ROLE_ARN --body "${ROLE_ARN}" --repo warefeats/kv-stores
    echo "set GH secret AWS_ROLE_ARN"
