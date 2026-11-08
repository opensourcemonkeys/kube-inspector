#!/bin/sh
# The container Kube Inspector's Cluster Migration runs on both clusters, one
# pod per volume and only while a migration is running. "receive" serves the
# target volume over SSH; "send" copies the source volume to it, once.
#
# The keys are generated per migration by the desktop app and arrive in a Secret
# mounted at /mover-keys.
set -eu

keys=/mover-keys

case "${1:-}" in
receive)
	mkdir -p /run/sshd
	exec /usr/sbin/sshd -D -e -p 2222 \
		-h "$keys/host_key" \
		-o AuthorizedKeysFile="$keys/authorized_keys" \
		-o PermitRootLogin=forced-commands-only \
		-o PasswordAuthentication=no \
		-o KbdInteractiveAuthentication=no \
		-o StrictModes=no \
		-o AllowTcpForwarding=no \
		-o X11Forwarding=no \
		-o PidFile=/run/sshd/sshd.pid
	;;
rsync-only)
	# The forced command of the migration key: it can run rsync and nothing else.
	case "${SSH_ORIGINAL_COMMAND:-}" in
	*[\;\&\|\`\$\<\>\(\)]*) echo "refused" >&2; exit 1 ;;
	"rsync --server "*) exec $SSH_ORIGINAL_COMMAND ;;
	*) echo "only rsync is allowed" >&2; exit 1 ;;
	esac
	;;
send)
	host=""
	for addr in ${MOVER_ADDRS:-}; do
		if nc -z -w 5 "${addr%:*}" "${addr##*:}" 2>/dev/null; then
			host=${addr%:*}
			port=${addr##*:}
			break
		fi
	done
	if [ -z "$host" ]; then
		echo "KUBE_INS_UNREACHABLE ${MOVER_ADDRS:-}"
		exit 3
	fi
	echo "KUBE_INS_ADDR $host:$port"

	set -- -aHAXS --numeric-ids --inplace --partial --no-inc-recursive --info=progress2 --stats
	if [ "${MOVER_FINAL:-}" = "1" ]; then
		# Nanosecond mtimes: a file rewritten in the same second as its last
		# copy, at the same size, would otherwise be taken as unchanged.
		set -- "$@" --delete --modify-window=-1
	fi
	if [ -n "${MOVER_BWLIMIT:-}" ]; then
		set -- "$@" "--bwlimit=$MOVER_BWLIMIT"
	fi

	set +e
	set -o pipefail
	# rsync redraws its progress with \r; the desktop reads whole log lines.
	rsync "$@" \
		-e "ssh -p $port -i $keys/id_key -o HostKeyAlias=kube-ins-mover -o UserKnownHostsFile=$keys/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15" \
		/data/ "root@$host:/data/" 2>&1 | tr '\r' '\n'
	rc=$?
	set -e
	echo "KUBE_INS_PASS_DONE rc=$rc"

	# 24 is "files vanished while copying", normal while the application runs.
	# The final pass runs with nothing writing, so there it stays an error.
	if [ "$rc" = "24" ] && [ "${MOVER_FINAL:-}" != "1" ]; then
		exit 0
	fi
	exit "$rc"
	;;
*)
	echo "usage: mover.sh receive|send" >&2
	exit 2
	;;
esac
