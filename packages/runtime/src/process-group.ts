/**
 * Record and reap a container process group.
 *
 * Docker can only abandon a timed-out `docker exec` — the process keeps running
 * inside the container (see `execInContainer`). Every exec is its own process
 * group leader, so recording `$$`'s group up front lets the host SIGKILL
 * exactly that exec and its descendants later, sparing the container's init
 * and keepalive (different groups). Used for the timed-out agent (before its
 * workspace is captured) and for timed-out scorers (before the next criterion
 * runs, so a dead scorer cannot keep spending or writing into the shared
 * workspace).
 */

/**
 * Shell prefix that records the current process-group id into `pgidFile`.
 * Best-effort and exit-code-transparent (`;`-separated, never changes the
 * launched command's status).
 *
 * Field 5 of `/proc/$$/stat` is the process-group id — read straight from
 * `/proc` rather than shelling out to `ps`, which isn't reliably present across
 * every experiment image. `mkdir -p` guarantees the dir exists before the write.
 */
export function pgidRecordPrefix(pgidFile: string): string {
  const dir = pgidFile.replace(/\/[^/]+$/, '');
  return `mkdir -p ${dir} 2>/dev/null; awk '{print $5}' /proc/$$/stat > ${pgidFile} 2>/dev/null || true; `;
}

/**
 * Shell command that SIGKILLs exactly the recorded process *group* (the
 * `-- -"$PGID"` form). Echoes a one-line status the caller logs; `label` names
 * what was reaped in that line.
 */
export function reapProcessGroupCommand(pgidFile: string, label: string): string {
  return `PGID=$(cat ${pgidFile} 2>/dev/null)
       if [ -z "$PGID" ]; then echo "no ${label} process group recorded; skipping"; exit 0; fi
       if kill -KILL -- -"$PGID" 2>/dev/null; then echo "reaped ${label} process group $PGID"
       else echo "${label} process group $PGID had no live processes"; fi`;
}
