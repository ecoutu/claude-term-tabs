#!/usr/bin/env bash
# Records docs/demo.gif: `ctt <words>` switching tabs, then `ctt pause` until "Safe to restart."
#
# Runs everything in a scratch HOME, on a hidden X display (Xvfb) with its own WezTerm, so it never
# touches your screen, your terminal or your real Claude Code sessions. The scratch sessions run Haiku,
# a few cents per run.
#
# Needs: Xvfb, ffmpeg, ffprobe, bc, wezterm, git, node 24+, claude, and a login for the scratch sessions
# in CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token` once) or ANTHROPIC_API_KEY. It never uses your
# ~/.claude/.credentials.json: a token refresh in a scratch session would leave yours logged out.
#
#   scripts/record-demo.sh [--keep] [--query WORDS] [SESSION_ID...]
#
# Each SESSION_ID (or its first characters) names one of your own sessions to show next to the made-up
# ones: its repository is cloned into the scratch HOME, on the session's branch (a worktree when two
# sessions share a repository), and the session's transcript is copied there and resumed. Your real
# checkout and transcript are never touched. The recording shows titles, repositories, branches and
# the HANDOFF replies, so only pass sessions you are happy to publish.
#
# --query is what the demo types after `ctt` (default: the first made-up session's topic).
# --keep leaves the scratch HOME and display up for debugging.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
keep=false
query="the rounding bug in billing"
real_ids=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --keep) keep=true ;;
    --query) query=$2; shift ;;
    -*) echo "record-demo: unknown option $1" >&2; exit 2 ;;
    *) real_ids+=("$1") ;;
  esac
  shift
done

for tool in Xvfb ffmpeg ffprobe bc wezterm git node npm claude; do
  command -v "$tool" >/dev/null || { echo "record-demo: $tool not found" >&2; exit 1; }
done
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  login_name=CLAUDE_CODE_OAUTH_TOKEN
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  login_name=ANTHROPIC_API_KEY
else
  echo "record-demo: set CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or ANTHROPIC_API_KEY" >&2
  exit 1
fi
login_value=${!login_name}

# Short base path: WezTerm's socket path must fit in a unix socket address.
base=$(mktemp -d "/tmp/ctt-demo.XXXX")
home=$base/h
display=
out=$repo/docs/demo.gif
claude_bin=$(command -v claude)
node_dir=$(dirname "$(command -v node)")
# fzf is optional, as for ctt itself; with it the pause list is the fzf one most people will see.
extra_path=$node_dir
command -v fzf >/dev/null && extra_path=$extra_path:$(dirname "$(command -v fzf)")
pids=()

cleanup () {
  if $keep; then
    echo "record-demo: kept $base (display $display)" >&2
  else
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    # Anything still running from the scratch display carries CTT_DEMO=$base; nothing else is touched.
    for e in /proc/[0-9]*/environ; do
      if grep -qzxF "CTT_DEMO=$base" "$e" 2>/dev/null; then p=${e#/proc/}; kill "${p%/environ}" 2>/dev/null || true; fi
    done
    rm -rf "$base"
  fi
}
trap cleanup EXIT

log () { printf 'record-demo: %s\n' "$*" >&2; }

# --- scratch HOME ---------------------------------------------------------------------------------

mkdir -p "$home/.claude" "$home/.config/wezterm" "$home/bin" "$base/run"
chmod 700 "$base/run"
echo '{ "theme": "dark" }' > "$home/.claude/settings.json"

cat > "$home/.config/wezterm/wezterm.lua" <<'EOF'
local wezterm = require 'wezterm'
return {
  front_end = 'Software',
  enable_wayland = false,
  font = wezterm.font 'DejaVu Sans Mono',
  font_size = 12,
  color_scheme = 'Builtin Solarized Dark',
  window_decorations = 'NONE',
  use_fancy_tab_bar = false,
  tab_max_width = 40,
  initial_cols = 150,
  initial_rows = 30,
  window_padding = { left = 10, right = 10, top = 8, bottom = 8 },
  check_for_updates = false,
  audible_bell = 'Disabled',
  window_close_confirmation = 'NeverPrompt',
}
EOF

cat > "$home/.bashrc" <<EOF
export PATH="$home/bin:$extra_path:\$PATH"
export DISABLE_AUTOUPDATER=1
export PS1='\[\e[1;34m\]\w\[\e[0m\] \$ '
EOF
echo '. ~/.bashrc' > "$home/.bash_profile"
ln -s "$claude_bin" "$home/bin/claude"

# ctt packed from this checkout and installed globally, as a user would install the npm package.
log "packing and installing claude-term-tabs"
tarball=$(cd "$repo" && npm pack --silent --pack-destination "$base" | tail -n 1)
npm install --global --silent --prefix "$home/.npm" "$base/$tarball" >/dev/null
ln -s "$home/.npm/bin/ctt" "$home/bin/ctt"

# Example repos (made-up names only), each with a session title, branch and first prompt.
sessions=(
  "infra-terraform|chore/rds-upgrade|Plan the Postgres 17 upgrade|We need to upgrade RDS to Postgres 17. Read rds.tf and list in three bullets what the upgrade touches. Do not edit anything."
)
[[ ${#real_ids[@]} -gt 0 ]] || sessions+=(
  "api-orders|fix/retry-timeouts|Fix retry timeouts in order sync|The order sync job times out when the payments API is slow. Read sync.ts and say in two sentences where a retry with backoff belongs. Do not edit anything."
  "web-checkout|feat/apple-pay|Add Apple Pay to checkout|We are adding Apple Pay to checkout. Read checkout.ts and list in three bullets what has to change. Do not edit anything."
  "billing-service|fix/invoice-rounding|Fix invoice rounding on refunds|Refunds are off by a cent. Read invoice.ts and say in two sentences where the rounding bug is. Do not edit anything."
)

trust='{}'
add_trust () {
  trust=$(node -e 'const t = JSON.parse(process.argv[1]); t[process.argv[2]] = { hasTrustDialogAccepted: true, allowedTools: [] }; console.log(JSON.stringify(t))' "$trust" "$1")
}

# Your own sessions: "dir|session id" for each, after cloning its repository into the scratch HOME.
# One clone per source repository (a second repository with the same name gets "-2"); more sessions
# of that repository get worktrees of its clone, even on a branch that is already checked out.
resumed=()
declare -A clone_of=()
for id in "${real_ids[@]}"; do
  matches=$(compgen -G "$HOME/.claude/projects/*/$id*.jsonl" || true)
  [[ -n "$matches" ]] || { log "no transcript for session $id"; exit 1; }
  [[ $(wc -l <<<"$matches") -eq 1 ]] || { log "session $id matches more than one transcript; give more of its id"; exit 1; }
  src=$matches
  IFS=$'\t' read -r sid cwd branch < <(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
    let cwd, branch = ""
    for (const l of lines) { try { const e = JSON.parse(l); cwd = e.cwd ?? cwd; if (e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch } catch {} }
    console.log([require("path").basename(process.argv[1], ".jsonl"), cwd, branch].join("\t"))
  ' "$src")
  # Worktrees of one repository share its common dir, so they count as one repository.
  top=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir)
  top=${top%/.git}
  name=$(basename "$(git -C "$top" remote get-url origin 2>/dev/null || echo "$top")" .git)
  if [[ -z ${clone_of[$top]:-} ]]; then
    dir=$home/src/$name n=2
    while [[ -e $dir ]]; do dir=$home/src/$name-$((n++)); done
    git clone -q "$top" "$dir"
    clone_of[$top]=$dir
    if [[ -n $branch ]]; then
      git -C "$dir" checkout -q "$branch" || { log "branch $branch of session $id is not in $top"; exit 1; }
    fi
  else
    suffix=${branch##*/}
    dir=${clone_of[$top]}-${suffix:-head} n=2
    while [[ -e $dir ]]; do dir=${clone_of[$top]}-${suffix:-head}-$((n++)); done
    git -C "${clone_of[$top]}" worktree add -q --force "$dir" "${branch:-HEAD}" ||
      { log "branch $branch of session $id is not in $top"; exit 1; }
  fi
  dest=$home/.claude/projects/$(printf %s "$dir" | sed 's/[^A-Za-z0-9]/-/g')
  mkdir -p "$dest"
  node -e '
    const fs = require("fs")
    const [src, dest, from, to] = process.argv.slice(1)
    fs.writeFileSync(dest, fs.readFileSync(src, "utf8").split(JSON.stringify(from)).join(JSON.stringify(to)), { mode: 0o600 })
  ' "$src" "$dest/$sid.jsonl" "$cwd" "$dir"
  add_trust "$dir"
  resumed+=("$dir|$sid")
done

for s in "${sessions[@]}"; do
  IFS='|' read -r name branch _ _ <<<"$s"
  dir=$home/src/$name
  mkdir -p "$dir"
  case $name in
    api-orders) printf 'export async function syncOrders (api) {\n  const orders = await api.get("/orders", { timeout: 2000 })\n  return orders.map(o => ({ id: o.id, total: o.total }))\n}\n' > "$dir/sync.ts" ;;
    web-checkout) printf 'export function paymentMethods () {\n  return ["card", "paypal"]\n}\n' > "$dir/checkout.ts" ;;
    billing-service) printf 'export function refundAmount (total: number, ratio: number) {\n  return Math.floor(total * ratio * 100) / 100\n}\n' > "$dir/invoice.ts" ;;
    infra-terraform) printf 'resource "aws_db_instance" "main" {\n  engine         = "postgres"\n  engine_version = "15.7"\n  instance_class = "db.r6g.large"\n}\n' > "$dir/rds.tf" ;;
  esac
  git -C "$dir" init -q -b main
  git -C "$dir" -c user.name=Demo -c user.email=demo@example.com add -A
  git -C "$dir" -c user.name=Demo -c user.email=demo@example.com -c commit.gpgsign=false commit -qm "initial commit"
  git -C "$dir" checkout -qb "$branch"
  add_trust "$dir"
done

# Onboarding done and every repo trusted, so no first-run dialogs; the account fields come from yours.
node -e '
  const fs = require("fs")
  const real = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const out = { hasCompletedOnboarding: true, lastOnboardingVersion: real.lastOnboardingVersion, numStartups: 50,
    oauthAccount: real.oauthAccount, userID: real.userID, projects: JSON.parse(process.argv[3]) }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2), { mode: 0o600 })
' "$HOME/.claude.json" "$home/.claude.json" "$trust"

# --- hidden display and WezTerm -------------------------------------------------------------------

# Xvfb picks a free display itself and writes its number to fd 3.
Xvfb -displayfd 3 -screen 0 1600x900x24 -nolisten tcp 3>"$base/display" 2>"$base/xvfb.log" &
pids+=("$!")
for _ in $(seq 50); do [[ -s "$base/display" ]] && break; sleep 0.1; done
[[ -s "$base/display" ]] || { log "Xvfb did not start; see $base/xvfb.log"; exit 1; }
display=:$(<"$base/display")

# Runs a command with the scratch environment only. The login goes in with the `export` builtin, never
# as an `env NAME=value` argument, so it never shows in a command line that other users can read.
demo_user=${USER:-demo} demo_lang=${LANG:-C.UTF-8}
denv () (
  for v in $(compgen -e); do unset "$v" 2>/dev/null || true; done
  export "$login_name=$login_value" CTT_DEMO="$base" HOME="$home" USER="$demo_user" \
    PATH="$home/bin:$extra_path:/usr/bin:/bin" SHELL=/bin/bash TERM=xterm-256color \
    LANG="$demo_lang" DISPLAY="$display" XDG_RUNTIME_DIR="$base/run"
  exec "$@"
)
denv wezterm --config-file "$home/.config/wezterm/wezterm.lua" start --always-new-process \
  --cwd "$home" -- bash -l >"$base/wezterm.log" 2>&1 &
pids+=("$!")

for _ in $(seq 50); do
  sock=$(compgen -G "$base/run/wezterm/gui-sock-*" | head -n 1 || true)
  [[ -n "$sock" ]] && break
  sleep 0.2
done
[[ -n "${sock:-}" ]] || { log "WezTerm did not start; see $base/wezterm.log"; exit 1; }
# `wezterm cli spawn` hands the caller's environment to the new pane, so call it with the scratch one only.
w () { denv env WEZTERM_UNIX_SOCKET="$sock" wezterm cli "$@"; }
sleep 2
shell_pane=$(w list --format json | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8"))[0].pane_id)')

# Record only the WezTerm window: crop away the empty display around it.
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1600x900 -i "$display" -frames:v 1 "$base/probe.png"
crop=$(ffmpeg -i "$base/probe.png" -vf cropdetect=limit=8:round=2:skip=0 -f null - 2>&1 | grep -o "crop=[0-9:]*" | tail -n 1 || true)
[[ -n "$crop" ]] || crop=crop=1600:900:0:0

# --- sessions -------------------------------------------------------------------------------------

no_tools=Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task
total=$((${#sessions[@]} + ${#resumed[@]}))
log "starting $total Claude Code sessions"
for r in "${resumed[@]}"; do
  IFS='|' read -r dir sid <<<"$r"
  # Their history names real paths and PRs, so they may only read and reply, never act.
  w spawn --pane-id "$shell_pane" --cwd "$dir" -- bash -lc "claude --model haiku --permission-mode default --disallowedTools $no_tools --resume $sid; exec bash -l" >/dev/null
done
for s in "${sessions[@]}"; do
  IFS='|' read -r name _ title prompt <<<"$s"
  w spawn --pane-id "$shell_pane" --cwd "$home/src/$name" -- bash -lc \
    "claude --model haiku --permission-mode default --disallowedTools $no_tools -n $(printf %q "$title") $(printf %q "$prompt"); exec bash -l" >/dev/null
done

# Claude Code asks to trust each scratch folder even when ~/.claude.json says it is trusted: say yes.
sleep 4
for _ in $(seq 20); do
  pending=0
  for pane in $(w list --format json | node -e 'for (const p of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(p.pane_id)'); do
    if [[ $(w get-text --pane-id "$pane") == *'Yes, I trust this folder'* ]]; then
      pending=1
      w send-text --pane-id "$pane" --no-paste $'\e[B'
      sleep 0.3
      w send-text --pane-id "$pane" --no-paste $'\r'
    fi
  done
  [[ $pending -eq 0 ]] && break
  sleep 2
done

# Wait until every session has answered its first prompt and is idle.
idle_count () {
  node -e '
    const fs = require("fs"), dir = process.argv[1]
    let n = 0
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try { if (JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")).status === "idle") n++ } catch {}
    }
    console.log(n)
  ' "$home/.claude/sessions"
}
for _ in $(seq 120); do
  [[ $(idle_count) -ge $total ]] && break
  sleep 1
done
[[ $(idle_count) -ge $total ]] || { log "sessions did not settle; rerun with --keep to look"; exit 1; }
sleep 2

# --- record ---------------------------------------------------------------------------------------

type_in () { # type like a person, then press Enter
  local text=$1 i
  for ((i = 0; i < ${#text}; i++)); do
    w send-text --pane-id "$shell_pane" --no-paste "${text:i:1}"
    sleep 0.045
  done
  sleep 0.3
  w send-text --pane-id "$shell_pane" --no-paste $'\r'
}

pane_text () { w get-text --pane-id "$shell_pane"; }

w activate-pane --pane-id "$shell_pane"
w send-text --pane-id "$shell_pane" --no-paste $'clear\r'
sleep 1

log "recording"
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -framerate 20 -video_size 1600x900 -i "$display" \
  -c:v libx264 -preset ultrafast -crf 18 "$base/demo.mp4" &
rec=$!
pids+=("$rec")
start=$(date +%s.%N)
mark () { echo "$1 $(echo "$(date +%s.%N) - $start" | bc)" >> "$base/marks"; }

sleep 0.5
type_in "ctt $query"
sleep 2.5          # the matching tab is in front now
mark switched
w activate-pane --pane-id "$shell_pane"
sleep 0.6
type_in "ctt pause"
mark pause
for _ in $(seq 180); do
  [[ $(pane_text) == *'Safe to restart'* ]] && break
  sleep 1
done
mark safe
sleep 2.5
kill -INT "$rec"; wait "$rec" || true

[[ $(pane_text) == *'Safe to restart'* ]] || { log "pause did not finish; rerun with --keep to look"; exit 1; }

# --- GIF ------------------------------------------------------------------------------------------

# Real time up to `ctt pause` plus 1.5 s; the wait in between sped up to 2.5 s; the last 2.5 s real time.
read -r _ t_pause < <(grep '^pause ' "$base/marks")
read -r _ t_safe < <(grep '^safe ' "$base/marks")
a_end=$(echo "a = $t_pause + 1.5; if (a > $t_safe) a = $t_safe; a" | bc)
b_end=$(echo "$t_safe + 0.3" | bc)
b_len=$(echo "$b_end - $a_end" | bc)
speed=$(echo "s = $b_len / 2.5; if (s < 1) s = 1; s" | bc -l)
log "pause wait ${b_len}s, shown $(printf %.1f "$speed") times faster"

ffmpeg -loglevel error -y -i "$base/demo.mp4" -filter_complex "
  [0:v]trim=0:$a_end,setpts=PTS-STARTPTS[a];
  [0:v]trim=$a_end:$b_end,setpts=(PTS-STARTPTS)/${speed}[b];
  [0:v]trim=start=$b_end,setpts=PTS-STARTPTS[c];
  [a][b][c]concat=n=3,$crop,fps=12,scale=1200:-1:flags=lanczos,split[x][y];
  [x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4" "$out"

log "wrote $out ($(du -h "$out" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s)"
