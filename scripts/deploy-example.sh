#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

vars_file="${1:-.tmp/deployment.vars}"
if [[ ! -f "$vars_file" ]]; then
  printf 'Missing deployment settings: %s\nCopy deployment.example.vars to .tmp/deployment.vars, edit it, then retry.\n' "$vars_file" >&2
  exit 2
fi
if [[ "$vars_file" == "deployment.example.vars" ]]; then
  printf 'Do not deploy with the checked-in placeholder template.\n' >&2
  exit 2
fi

WORKER_NAME='retro'
ALLOWED_EMAIL_DOMAIN=''
ACCESS_TEAM_ISSUER=''
ACCESS_AUD=''
APP_ORIGIN=''
ADMIN_EMAILS=''
VITE_GIPHY_API_KEY=''

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ "$line" != *=* ]]; then
    printf 'Invalid settings line (expected KEY=value).\n' >&2
    exit 2
  fi
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    WORKER_NAME|ALLOWED_EMAIL_DOMAIN|ACCESS_TEAM_ISSUER|ACCESS_AUD|APP_ORIGIN|ADMIN_EMAILS|VITE_GIPHY_API_KEY)
      printf -v "$key" '%s' "$value"
      ;;
    *)
      printf 'Unknown deployment setting: %s\n' "$key" >&2
      exit 2
      ;;
  esac
done < "$vars_file"

for key in ALLOWED_EMAIL_DOMAIN ACCESS_TEAM_ISSUER ACCESS_AUD APP_ORIGIN; do
  if [[ -z "${!key}" ]]; then
    printf 'Required setting %s is empty in %s.\n' "$key" "$vars_file" >&2
    exit 2
  fi
done

if [[ "$ALLOWED_EMAIL_DOMAIN" == *replace-me* || "$ALLOWED_EMAIL_DOMAIN" == *example.invalid* ||
      "$ACCESS_TEAM_ISSUER" == *replace-me* || "$ACCESS_AUD" == *replace-me* ||
      "$APP_ORIGIN" == *example.invalid* || "$WORKER_NAME" == *replace-me* ||
      "$VITE_GIPHY_API_KEY" == *replace-me* ]]; then
  printf 'Replace all deployment placeholders before deploying.\n' >&2
  exit 2
fi
if [[ "$ACCESS_TEAM_ISSUER" != https://* || "$APP_ORIGIN" != https://* ]]; then
  printf 'The Access issuer and app origin must use HTTPS.\n' >&2
  exit 2
fi
if [[ ${#WORKER_NAME} -gt 63 || ! "$WORKER_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  printf 'WORKER_NAME must be 1–63 lowercase letters, digits, or hyphens; it cannot start or end with a hyphen.\n' >&2
  exit 2
fi

app_host="${APP_ORIGIN#https://}"
if [[ "$app_host" == "$APP_ORIGIN" || "$app_host" == */* || "$app_host" == *\?* || "$app_host" == *\#* || "$app_host" == *@* ]]; then
  printf 'APP_ORIGIN must be an HTTPS origin only (no path, query, credentials, or fragment).\n' >&2
  exit 2
fi
if [[ "$app_host" == *.workers.dev && "$app_host" != "$WORKER_NAME".*.workers.dev ]]; then
  printf 'For a workers.dev origin, APP_ORIGIN must match %s.<account-subdomain>.workers.dev.\n' "$WORKER_NAME" >&2
  exit 2
fi

deploy_args=(
  deploy
  --name "$WORKER_NAME"
  --var "ALLOWED_EMAIL_DOMAIN:$ALLOWED_EMAIL_DOMAIN"
  --var "ACCESS_TEAM_ISSUER:$ACCESS_TEAM_ISSUER"
  --var "ACCESS_AUD:$ACCESS_AUD"
  --var "APP_ORIGIN:$APP_ORIGIN"
)
if [[ -n "$ADMIN_EMAILS" ]]; then
  deploy_args+=(--var "ADMIN_EMAILS:$ADMIN_EMAILS")
fi

printf 'Building RetroFlare and deploying to %s.\n' "$APP_ORIGIN"
export VITE_GIPHY_API_KEY
npm run build
./node_modules/.bin/wrangler "${deploy_args[@]}"
