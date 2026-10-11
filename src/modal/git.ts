export const initializeGit =
  'set -eu; if [ ! -d "$4/.git" ]; then git clone -- "$1" "$4"; git -C "$4" switch -c "atoi/$2"; fi; git -C "$4" config user.name "atoi agent"; git -C "$4" config user.email "agent@atoi.invalid"; if [ -n "$3" ]; then git -C "$4" fetch origin "$3"; test "$(git -C "$4" rev-parse FETCH_HEAD)" = "$3"; git -C "$4" checkout --detach "$3"; fi';
