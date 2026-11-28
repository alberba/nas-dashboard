#!/bin/sh
# Send a signed test event to the hub's notification ingest.
#
# Usage:
#   read -rs NOTIFY_INGEST_SECRET && export NOTIFY_INGEST_SECRET
#   scripts/ingest-test-event.sh --url https://hub.example/api/notifications/ingest \
#     --source backup --host-id nas-home --key backup-failed --state both \
#     --error "prueba de ingest"
#
# Flags: --url, --source (backup | issue-automator), --host-id, --key,
#   --state (open | resolved | both), --event-id, --subject, --reported-by,
#   --problem, --error.
# The secret is read only from NOTIFY_INGEST_SECRET; --secret is rejected so it
# never lands in shell history. (openssl still receives it as an argument for
# the instant the signature takes, as the HMAC tool offers no other input.)
# `--state both` sends `open` and then `resolved`, with the event id suffixed
# `:open` and `:resolved`, so the test leaves nothing open.
#
# Environment:
#   NOTIFY_INGEST_SECRET  required, the shared HMAC secret
#   INGEST_DRY_RUN=1      print headers and body, send nothing
#   INGEST_TIMESTAMP      fix the timestamp (tests only; 10 digits)
#
# Needs jq, openssl and curl. On an Alpine container:
#   apk add --no-cache curl openssl jq
set -eu

usage_error() {
  echo "ingest-test-event: $1" >&2
  exit 2
}

url=""
source_name=""
host_id=""
key=""
state="open"
event_id=""
subject=""
reported_by=""
problem=""
error_text=""

need_value() {
  [ "$1" -ge 2 ] || usage_error "$2 needs a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --secret | --secret=*)
      usage_error "the secret is only read from NOTIFY_INGEST_SECRET"
      ;;
    --url) need_value "$#" "$1"; url=$2; shift 2 ;;
    --source) need_value "$#" "$1"; source_name=$2; shift 2 ;;
    --host-id) need_value "$#" "$1"; host_id=$2; shift 2 ;;
    --key) need_value "$#" "$1"; key=$2; shift 2 ;;
    --state) need_value "$#" "$1"; state=$2; shift 2 ;;
    --event-id) need_value "$#" "$1"; event_id=$2; shift 2 ;;
    --subject) need_value "$#" "$1"; subject=$2; shift 2 ;;
    --reported-by) need_value "$#" "$1"; reported_by=$2; shift 2 ;;
    --problem) need_value "$#" "$1"; problem=$2; shift 2 ;;
    --error) need_value "$#" "$1"; error_text=$2; shift 2 ;;
    *) usage_error "unknown flag: $1" ;;
  esac
done

[ -n "${NOTIFY_INGEST_SECRET:-}" ] || usage_error "NOTIFY_INGEST_SECRET is not set"

case "$source_name" in
  backup | issue-automator) ;;
  *) usage_error "--source must be backup or issue-automator" ;;
esac
case "$state" in
  open | resolved | both) ;;
  *) usage_error "--state must be open, resolved or both" ;;
esac
[ -n "$host_id" ] || usage_error "--host-id is required"
[ -n "$key" ] || usage_error "--key is required"

dry_run=${INGEST_DRY_RUN:-}
if [ "$dry_run" != "1" ]; then
  [ -n "$url" ] || usage_error "--url is required"
fi

timestamp=${INGEST_TIMESTAMP:-$(date +%s)}
case "$timestamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) usage_error "INGEST_TIMESTAMP must be 10 digits" ;;
esac

if [ -z "$event_id" ]; then
  event_id="test:${key}:${timestamp}"
fi
case "$event_id" in
  *[!A-Za-z0-9._:-]*) usage_error "--event-id may only use letters, digits and . _ : -" ;;
esac

# Builds the body for one state and event id, keys in the contract's order.
build_body() {
  jq -nc \
    --arg source "$source_name" \
    --arg eventId "$1" \
    --arg hostId "$host_id" \
    --arg key "$key" \
    --arg state "$2" \
    --arg error "$error_text" \
    --arg subject "$subject" \
    --arg reportedBy "$reported_by" \
    --arg problem "$problem" \
    '{v: 1, source: $source, eventId: $eventId, hostId: $hostId, key: $key, state: $state}
     + (
       {}
       | if $error != "" then .errors = [$error] else . end
       | if $subject != "" then .subject = $subject else . end
       | if $reportedBy != "" then .reportedBy = $reportedBy else . end
       | if $problem != "" then .problem = $problem else . end
       | if length > 0 then {data: .} else {} end
     )'
}

sign() {
  printf '%s.%s' "$timestamp" "$1" \
    | openssl dgst -sha256 -hmac "$NOTIFY_INGEST_SECRET" \
    | sed 's/^.*= *//'
}

# Signs and sends (or, in a dry run, prints) one event.
send_one() {
  body=$(build_body "$1" "$2")
  signature=$(sign "$body")
  case "$signature" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) echo "ingest-test-event: could not compute the signature" >&2; exit 1 ;;
  esac

  if [ "$dry_run" = "1" ]; then
    printf 'X-Ingest-Timestamp: %s\n' "$timestamp"
    printf 'X-Ingest-Signature: v1=%s\n' "$signature"
    printf '%s\n' "$body"
    return 0
  fi

  if ! response=$(
    printf '%s' "$body" | curl -sS --max-time 10 \
      -w '\n%{http_code}' \
      -H 'Content-Type: application/json' \
      -H "X-Ingest-Timestamp: $timestamp" \
      -H "X-Ingest-Signature: v1=$signature" \
      --data-binary @- "$url"
  ); then
    echo "ingest-test-event: the request to the ingest failed" >&2
    exit 1
  fi
  code=$(printf '%s\n' "$response" | tail -n 1)
  text=$(printf '%s\n' "$response" | sed '$d')
  printf '%s %s %s\n' "$2" "$code" "$text"
  case "$code" in
    2??) ;;
    *) exit 1 ;;
  esac
}

if [ "$state" = "both" ]; then
  send_one "${event_id}:open" open
  send_one "${event_id}:resolved" resolved
else
  send_one "$event_id" "$state"
fi
