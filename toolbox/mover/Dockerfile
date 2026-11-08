# The worker Kube Inspector's Cluster Migration starts on both clusters: rsync
# over SSH, one pod per volume, removed when the migration ends. It runs as root
# because copying a volume has to keep every file's owner.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache rsync openssh-server openssh-client-default \
	&& sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
COPY mover.sh /mover.sh
ENTRYPOINT ["/mover.sh"]
