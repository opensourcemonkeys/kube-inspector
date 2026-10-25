#!/usr/bin/env bash
# End-to-end test on kind: a cluster whose API server sends audit events to
# toolbox, a Helm install with the bundled ClickHouse, real writes made as
# different users, then assertions against the REST API.
#
#   hack/kind/e2e.sh          # create cluster, test, delete cluster
#   KEEP=1 hack/kind/e2e.sh   # leave the cluster running afterwards
#                             # (kubeconfig: hack/kind/.work/kubeconfig)
#
# Needs: docker, kind, helm, kubectl, python3.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/hack/kind/.work"
CLUSTER=${CLUSTER:-toolbox-e2e}
NS=toolbox
RELEASE=toolbox
CTX="kind-$CLUSTER"
K="kubectl --context $CTX"
PORT=${PORT:-18080}
CH_IMAGE=clickhouse/clickhouse-server:25.8

log() { printf '\n==> %s\n' "$*"; }

cleanup() {
  [[ -n "${PF_PID:-}" ]] && kill "$PF_PID" 2>/dev/null || true
  if [[ -z "${KEEP:-}" ]]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Never touch the user's ~/.kube/config: kind would add a context and switch
# current-context to it.
mkdir -p "$WORK/audit"
export KUBECONFIG="$WORK/kubeconfig"

log "preparing audit files"
cp "$ROOT/deploy/helm/toolbox/files/audit-policy.yaml" "$WORK/audit/policy.yaml"
cp "$ROOT/hack/kind/audit-webhook.yaml" "$WORK/audit/webhook.yaml"
sed "s#__AUDIT_DIR__#$WORK/audit#" "$ROOT/hack/kind/kind-config.yaml.tpl" > "$WORK/kind-config.yaml"

# Always start clean: rows left in ClickHouse by an earlier run could
# satisfy the assertions on their own.
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
log "creating kind cluster $CLUSTER"
kind create cluster --name "$CLUSTER" --config "$WORK/kind-config.yaml" --wait 120s

log "building image"
docker build -q -t toolbox:e2e "$ROOT" >/dev/null
kind load docker-image toolbox:e2e --name "$CLUSTER"
# Optional speed-up; kind cannot load some multi-platform images, and the
# node can always pull it instead.
if docker image inspect "$CH_IMAGE" >/dev/null 2>&1; then
  kind load docker-image "$CH_IMAGE" --name "$CLUSTER" >/dev/null 2>&1 || true
fi

install() {
  helm --kube-context "$CTX" upgrade --install "$RELEASE" "$ROOT/deploy/helm/toolbox" \
    --namespace "$NS" --create-namespace \
    --set clusterName=e2e \
    --set image.repository=toolbox --set image.tag=e2e --set image.pullPolicy=Never \
    --set apiToken=e2e-api-token \
    --set audit.service.clusterIP=10.96.200.200 \
    --set clickhouse.persistence.enabled=false \
    --set clickhouse.resources.requests.memory=256Mi \
    "$@" --wait --timeout 5m
  $K -n "$NS" rollout status deploy/"$RELEASE" --timeout 3m
}

log "installing toolbox (audit + admission)"
install --set auditToken=e2e-audit-token

log "port-forwarding the API"
$K -n "$NS" port-forward svc/"$RELEASE" "$PORT:8080" >/dev/null 2>&1 &
PF_PID=$!
sleep 3

# Leader election, informer start and the first discovery take a moment; a
# change made before the informers are synced is part of their initial list.
log "waiting for the leader to start watching"
for i in $(seq 1 60); do
  if $K -n "$NS" logs -l app.kubernetes.io/component=collector --tail=-1 2>/dev/null | grep -q '"msg":"watching","resource":"/v1, Resource=configmaps"'; then break; fi
  sleep 2
done
sleep 5

log "scenario 1: writes as alice and bob, audit + admission"
$K create namespace e2e
$K -n e2e create rolebinding devs --clusterrole=edit --user=alice --user=bob --user=carol
$K --as=alice -n e2e create configmap app-config --from-literal=a=1
$K --as=alice -n e2e patch configmap app-config -p '{"data":{"a":"2"}}'
$K --as=bob -n e2e create deployment web --image=registry.k8s.io/pause:3.10 --replicas=1
$K --as=bob -n e2e scale deployment web --replicas=2
$K --as=alice -n e2e create secret generic s1 --from-literal=pw=hunter2
$K --as=alice -n e2e patch secret s1 -p '{"stringData":{"pw":"hunter3"}}'
$K --as=alice -n e2e delete configmap app-config
$K --as=mallory -n e2e delete configmap nope 2>/dev/null || true

python3 "$ROOT/hack/kind/assert.py" "http://localhost:$PORT" e2e-api-token scenario1

log "scenario 2: audit token rotated away, admission only"
install --set auditToken=not-the-token-the-apiserver-has
$K -n "$NS" rollout status deploy/"$RELEASE" --timeout 3m
kill "$PF_PID" 2>/dev/null || true
$K -n "$NS" port-forward svc/"$RELEASE" "$PORT:8080" >/dev/null 2>&1 &
PF_PID=$!
sleep 25 # new leader: lease handover + discovery
$K --as=carol -n e2e create configmap only-admission --from-literal=x=1
$K --as=carol -n e2e patch configmap only-admission -p '{"data":{"x":"2"}}'

python3 "$ROOT/hack/kind/assert.py" "http://localhost:$PORT" e2e-api-token scenario2

log "e2e passed"
