#!/bin/sh

# AI Terminal managed Claude Code status line.
# Claude provides live session metadata as one JSON object on stdin.
input=$(cat)

if command -v jq >/dev/null 2>&1; then
  # @sh quotes every value before eval, including model/custom-agent names.
  parsed=$(printf '%s' "$input" | jq -r '
    "model=" + ((.model.display_name // .model.id // "Claude") | @sh),
    "effort=" + ((.effort.level // "default") | @sh),
    "custom_agent=" + ((.agent.name // "") | @sh),
    "fast=" + ((.fast_mode // false | tostring) | @sh),
    "input_tokens=" + ((.context_window.total_input_tokens // 0 | tostring) | @sh),
    "output_tokens=" + ((.context_window.total_output_tokens // 0 | tostring) | @sh),
    "cache_read=" + ((.context_window.current_usage.cache_read_input_tokens // 0 | tostring) | @sh),
    "cache_write=" + ((.context_window.current_usage.cache_creation_input_tokens // 0 | tostring) | @sh),
    "cost=" + ((.cost.total_cost_usd // 0 | tostring) | @sh),
    "context_pct=" + ((.context_window.used_percentage // "") | tostring | @sh),
    "context_window=" + ((.context_window.context_window_size // 0 | tostring) | @sh),
    "subscription=" + (((.rate_limits // null) != null | tostring) | @sh)
  ')
  eval "$parsed"
else
  # Dependency-free fallback for machines without jq. Claude emits compact JSON
  # and these display fields do not normally contain escaped quotes.
  get_string() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
  get_number() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9.][0-9.]*\).*/\1/p"; }
  model=$(get_string display_name)
  effort=$(printf '%s' "$input" | sed -n 's/.*"effort"[[:space:]]*:[[:space:]]*{[^}]*"level"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  custom_agent=$(printf '%s' "$input" | sed -n 's/.*"agent"[[:space:]]*:[[:space:]]*{[^}]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  fast=$(printf '%s' "$input" | grep -q '"fast_mode"[[:space:]]*:[[:space:]]*true' && printf true || printf false)
  input_tokens=$(get_number total_input_tokens)
  output_tokens=$(get_number total_output_tokens)
  cache_read=$(get_number cache_read_input_tokens)
  cache_write=$(get_number cache_creation_input_tokens)
  cost=$(get_number total_cost_usd)
  context_pct=$(get_number used_percentage)
  context_window=$(get_number context_window_size)
  subscription=$(printf '%s' "$input" | grep -q '"rate_limits"[[:space:]]*:' && printf true || printf false)
  [ -n "$model" ] || model=Claude
  [ -n "$effort" ] || effort=default
fi

: "${input_tokens:=0}" "${output_tokens:=0}" "${cache_read:=0}" "${cache_write:=0}"
: "${cost:=0}" "${context_window:=0}" "${subscription:=false}"

format_tokens() {
  awk -v n="${1:-0}" 'BEGIN {
    if (n < 1000) printf "%.0f", n;
    else if (n < 10000) printf "%.1fk", n / 1000;
    else if (n < 1000000) printf "%.0fk", n / 1000;
    else if (n < 10000000) printf "%.1fM", n / 1000000;
    else printf "%.0fM", n / 1000000;
  }'
}
positive() { awk -v n="${1:-0}" 'BEGIN { exit !(n > 0) }'; }
append_part() { [ -z "$left" ] && left=$1 || left="$left $1"; }

left=
positive "$input_tokens" && append_part "↑$(format_tokens "$input_tokens")"
positive "$output_tokens" && append_part "↓$(format_tokens "$output_tokens")"
positive "$cache_read" && append_part "R$(format_tokens "$cache_read")"
positive "$cache_write" && append_part "W$(format_tokens "$cache_write")"
if positive "$cache_read" && positive "$input_tokens"; then
  cache_hit=$(awk -v r="$cache_read" -v total="$input_tokens" 'BEGIN { printf "%.1f", r * 100 / total }')
  append_part "CH${cache_hit}%"
fi
if positive "$cost" || [ "$subscription" = true ]; then
  cost_text=$(awk -v n="$cost" 'BEGIN { printf "$%.3f", n }')
  [ "$subscription" != true ] || cost_text="$cost_text (sub)"
  append_part "$cost_text"
fi
window_text=$(format_tokens "$context_window")
if [ -n "${context_pct:-}" ]; then
  pct_text=$(awk -v n="$context_pct" 'BEGIN { printf "%.1f", n }')
  context_text="${pct_text}%/${window_text} (auto)"
else
  context_text="?/${window_text} (auto)"
fi
append_part "$context_text"

agent=Claude
[ -z "$custom_agent" ] || agent="Claude:$custom_agent"
right_plain="$agent · $model · $effort"
[ "$fast" != true ] || right_plain="$right_plain · Fast"
right_rest=${right_plain#"$agent"}

cols=${COLUMNS:-80}
case "$cols" in (*[!0-9]*|'') cols=80;; esac
# Claude's status-line component has its own horizontal padding. Leave an extra
# six-cell safety margin so its renderer never replaces the model tail with ….
content_cols=$((cols - 6))
[ "$content_cols" -ge 20 ] || content_cols=20
available_left=$((content_cols - ${#right_plain} - 2))
if [ "$available_left" -lt 0 ]; then
  available_left=0
fi
# Keep the right-side identity visible on narrow panes. Drop lower-priority
# token details in stages instead of letting Claude truncate the model/effort.
if [ ${#left} -gt "$available_left" ]; then
  cost_compact=$(awk -v n="$cost" 'BEGIN { printf "$%.3f", n }')
  [ "$subscription" != true ] || cost_compact="$cost_compact (sub)"
  left="$cost_compact $context_text"
fi
if [ ${#left} -gt "$available_left" ]; then left="$context_text"; fi
if [ ${#left} -gt "$available_left" ]; then left=; fi
padding=$((content_cols - ${#left} - ${#right_plain}))
[ "$padding" -ge 1 ] || padding=1

# Starting with an ANSI sequence prevents Claude from trimming alignment spaces.
# Keep metadata at normal brightness; only the agent identity is orange.
printf '\033[0m%s%*s\033[38;5;173m%s\033[0m%s\033[0m\n' "$left" "$padding" '' "$agent" "$right_rest"
