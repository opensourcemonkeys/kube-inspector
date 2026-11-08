#!/usr/bin/env bash
# End-to-end test of Cluster Migration on two kind clusters: a real backend
# (--serve, driven over its RPC endpoint), a real mover image, real volumes.
#
#   hack/kind/migration-e2e.sh          # create clusters, test, delete them
#   KEEP=1 hack/kind/migration-e2e.sh   # leave the clusters running afterwards
#
# Needs: docker, kind (or KIND=/path/to/kind), kubectl, curl, python3, go.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
WORK="$ROOT/toolbox/hack/kind/.work/migration"
KIND=${KIND:-kind}
SRC=mig-src
DST=mig-dst
PORT=${PORT:-34777}
MOVER=kube-inspector-toolbox-migrator:e2e
NS=shop

log() { printf '\n==> %s\n' "$*"; }
ks() { kubectl --kubeconfig "$WORK/$SRC.yaml" "$@"; }
kd() { kubectl --kubeconfig "$WORK/$DST.yaml" "$@"; }

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    log "FAILED; backend log and pods follow"
    tail -n 60 "$WORK/backend.log" 2>/dev/null || true
    ks get pods,jobs -A -l kube-ins/mover=true 2>/dev/null || true
    kd get pods,svc -A -l kube-ins/mover=true 2>/dev/null || true
  fi
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  if [[ -z "${KEEP:-}" ]]; then
    "$KIND" delete cluster --name "$SRC" >/dev/null 2>&1 || true
    "$KIND" delete cluster --name "$DST" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/home/.kube-ins"

log "creating clusters"
for c in "$SRC" "$DST"; do
  "$KIND" create cluster --name "$c" --kubeconfig "$WORK/$c.yaml" --wait 120s
  cp "$WORK/$c.yaml" "$WORK/home/.kube-ins/$c.yaml"
done

log "building and loading the mover image"
docker build -t "$MOVER" "$ROOT/toolbox/mover"
for c in "$SRC" "$DST"; do "$KIND" load docker-image "$MOVER" --name "$c"; done

log "creating the application on the source"
ks apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata: {name: $NS}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: conf, namespace: $NS}
data: {greeting: hello}
---
apiVersion: v1
kind: Secret
metadata: {name: cred, namespace: $NS}
stringData: {password: s3cret}
---
apiVersion: v1
kind: Service
metadata: {name: web, namespace: $NS}
spec:
  type: NodePort
  selector: {app: web}
  ports: [{port: 80}]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data, namespace: $NS}
spec:
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 1Gi}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: $NS}
spec:
  replicas: 1
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - {name: c, image: $MOVER, imagePullPolicy: IfNotPresent, command: [sleep, "86400"], volumeMounts: [{name: v, mountPath: /data}]}
      volumes:
        - {name: v, persistentVolumeClaim: {claimName: data}}
---
apiVersion: v1
kind: Service
metadata: {name: db, namespace: $NS}
spec:
  clusterIP: None
  selector: {app: db}
  ports: [{port: 5432}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db, namespace: $NS}
spec:
  serviceName: db
  replicas: 1
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - {name: c, image: $MOVER, imagePullPolicy: IfNotPresent, command: [sleep, "86400"], volumeMounts: [{name: vol, mountPath: /data}]}
  volumeClaimTemplates:
    - metadata: {name: vol}
      spec:
        accessModes: [ReadWriteOnce]
        resources: {requests: {storage: 1Gi}}
---
apiVersion: batch/v1
kind: CronJob
metadata: {name: tick, namespace: $NS}
spec:
  schedule: "0 0 1 1 *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - {name: c, image: $MOVER, imagePullPolicy: IfNotPresent, command: ["true"]}
YAML
ks -n "$NS" rollout status deploy/web --timeout=180s
ks -n "$NS" rollout status sts/db --timeout=180s

log "writing data"
ks -n "$NS" exec deploy/web -- sh -c 'dd if=/dev/urandom of=/data/blob bs=1M count=20 2>/dev/null; echo first > /data/marker; touch /data/owned; chown 1234:2345 /data/owned; chmod 640 /data/owned; touch /data/to-delete'
ks -n "$NS" exec sts/db -- sh -c 'dd if=/dev/urandom of=/data/table bs=1M count=5 2>/dev/null'
BLOB_SUM=$(ks -n "$NS" exec deploy/web -- md5sum /data/blob | cut -d' ' -f1)
TABLE_SUM=$(ks -n "$NS" exec sts/db -- md5sum /data/table | cut -d' ' -f1)

log "starting the backend"
(cd "$ROOT" && go build -tags kubeinsdev -o "$WORK/kube-ins" .)
HOME="$WORK/home" KUBE_INS_DEV_PORT=$PORT "$WORK/kube-ins" --serve </dev/null >"$WORK/backend.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fs -o /dev/null -X POST "http://127.0.0.1:$PORT/rpc/GetAppInfo" -d '[]' && break
  sleep 0.5
done

# rpc METHOD 'JSON args': prints the result; a backend error ends the test.
rpc() {
  curl -fsS -X POST "http://127.0.0.1:$PORT/rpc/$1" -H 'Content-Type: application/json' -d "$2" |
    python3 -c 'import json,sys
r=json.load(sys.stdin)
if not r.get("ok"):
    sys.exit("rpc error: "+str(r.get("error")))
print(json.dumps(r.get("result")))'
}
jq_py() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

REQ="{\"source\":\"$SRC\",\"target\":\"$DST\",\"namespaces\":[\"$NS\"],\"moverImage\":\"$MOVER\",\"storageClasses\":{},\"decisions\":{},\"bandwidthKBps\":0}"

log "preflight"
rpc MigrationPreflight "[$REQ]" | tee "$WORK/preflight.json" | jq_py '
print("objects", len(d["objects"]), "disks", [(x["name"], x["targetClass"], x["copy"], x["liveCopy"]) for x in d["disks"]])
print("issues", d["issues"]); print("missing", d["missing"])
assert not [i for i in d["issues"] if i["blocker"]], "blocked"
assert len(d["disks"]) == 2'

log "starting the migration"
ID=$(rpc MigrationStart "[$REQ]" | jq_py 'print(d)')
echo "id: $ID"

wait_phase() {
  local want=$1 limit=$2 state=""
  for _ in $(seq 1 "$limit"); do
    state=$(rpc MigrationGetRunning "[\"$SRC\"]")
    if [[ "$state" == "null" ]]; then echo "finished"; return 0; fi
    if echo "$state" | jq_py "import sys as s; s.exit(0 if d['phase']=='$want' else 1)"; then return 0; fi
    if echo "$state" | jq_py "import sys as s; s.exit(0 if d['phase']=='failed' else 1)"; then echo "$state"; return 1; fi
    sleep 2
  done
  echo "timed out waiting for $want: $state"
  return 1
}
wait_phase ready 150
rpc MigrationGetRunning "[\"$SRC\"]" | jq_py 'print([(x["name"], x["passes"], x["bytesCopied"], x.get("error")) for x in d["disks"]]); assert all(x["passes"]>=1 for x in d["disks"])'

log "the target holds everything back before the switch"
[[ "$(kd -n "$NS" get deploy web -o jsonpath='{.spec.replicas}')" == 0 ]]
[[ "$(kd -n "$NS" get cronjob tick -o jsonpath='{.spec.suspend}')" == true ]]
[[ "$(kd -n "$NS" get pvc data -o jsonpath='{.metadata.labels.kube-ins/migration}')" == "$ID" ]] || { echo "no migration label"; exit 1; }

log "writing on the source after the first copy"
ks -n "$NS" exec deploy/web -- sh -c 'echo after-first-pass >> /data/marker; rm /data/to-delete'

log "final switch"
rpc MigrationStartCutover "[\"$ID\"]" >/dev/null
for _ in $(seq 1 150); do
  [[ "$(rpc MigrationGetRunning "[\"$SRC\"]")" == "null" ]] && break
  sleep 2
done
RESULT=$(rpc MigrationGetResult "[\"$ID\"]")
echo "$RESULT" | jq_py 'print(json.dumps(d, indent=1)); assert d["phase"]=="done", d.get("error")'

log "asserting the target"
kd -n "$NS" rollout status deploy/web --timeout=180s
kd -n "$NS" rollout status sts/db --timeout=180s
[[ "$(kd -n "$NS" exec deploy/web -- md5sum /data/blob | cut -d' ' -f1)" == "$BLOB_SUM" ]]
[[ "$(kd -n "$NS" exec sts/db -- md5sum /data/table | cut -d' ' -f1)" == "$TABLE_SUM" ]]
kd -n "$NS" exec deploy/web -- cat /data/marker | tee "$WORK/marker" 
grep -q after-first-pass "$WORK/marker"
[[ "$(kd -n "$NS" exec deploy/web -- stat -c '%u:%g:%a' /data/owned)" == "1234:2345:640" ]]
if kd -n "$NS" exec deploy/web -- test -e /data/to-delete; then echo "a file deleted on the source survived"; exit 1; fi
[[ "$(kd -n "$NS" get secret cred -o jsonpath='{.data.password}' | base64 -d)" == s3cret ]]
[[ "$(kd -n "$NS" get cronjob tick -o jsonpath='{.spec.suspend}')" == false ]]
[[ "$(kd -n "$NS" get svc db -o jsonpath='{.spec.clusterIP}')" == None ]]

log "asserting nothing is left behind"
[[ -z "$(ks get pods,jobs,secrets -n "$NS" -l kube-ins/mover=true -o name)" ]]
[[ -z "$(kd get pods,services,secrets -n "$NS" -l kube-ins/mover=true -o name)" ]]
[[ -z "$(kd get deploy,sts,pvc,cm,secret,svc,cronjob -n "$NS" -l kube-ins/migration -o name)" ]]

log "asserting the source stopped"
[[ "$(ks -n "$NS" get deploy web -o jsonpath='{.spec.replicas}')" == 0 ]]
[[ "$(ks -n "$NS" get cronjob tick -o jsonpath='{.spec.suspend}')" == true ]]
echo "$RESULT" | jq_py 'assert d["sourceStopped"] is True; assert all(w["desired"]==1 for w in d["workloads"]); assert d["downtimeSeconds"]>0'

log "starting the source again"
rpc MigrationRestartSource "[\"$ID\"]" >/dev/null
[[ "$(ks -n "$NS" get deploy web -o jsonpath='{.spec.replicas}')" == 1 ]]
[[ "$(ks -n "$NS" get sts db -o jsonpath='{.spec.replicas}')" == 1 ]]
[[ "$(ks -n "$NS" get cronjob tick -o jsonpath='{.spec.suspend}')" == false ]]
[[ -z "$(ks -n "$NS" get deploy web -o jsonpath='{.metadata.annotations.kube-ins/migration-replicas}')" ]]

log "PASS"
