VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE   ?= ghcr.io/opensourcemonkeys/kube-inspector-toolbox
CHART   := deploy/helm/toolbox
CH_TEST_PORT ?= 19000

.PHONY: build test test-store bench-store vet lint docker helm-lint helm-template e2e clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/toolbox ./cmd/toolbox

test:
	go test -race ./...

# Runs the ClickHouse-backed store tests against a throwaway container.
test-store:
	docker run -d --rm --name toolbox-ch-test -p $(CH_TEST_PORT):9000 -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server:25.8 >/dev/null
	@until docker exec toolbox-ch-test clickhouse-client --password test -q 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
	CLICKHOUSE_TEST_ADDR=localhost:$(CH_TEST_PORT) CLICKHOUSE_TEST_PASSWORD=test go test -count=1 ./internal/store/; \
		status=$$?; docker rm -f toolbox-ch-test >/dev/null; exit $$status

# Times every API read on synthetic data (50M rows unless TOOLBOX_BENCH_ROWS
# says otherwise) in a throwaway ClickHouse; a report, read the log.
bench-store:
	docker run -d --rm --name toolbox-ch-bench -p $(CH_TEST_PORT):9000 -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server:25.8 >/dev/null
	@until docker exec toolbox-ch-bench clickhouse-client --password test -q 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
	CLICKHOUSE_TEST_ADDR=localhost:$(CH_TEST_PORT) CLICKHOUSE_TEST_PASSWORD=test go test -tags bench -run TestReadLatency -count=1 -v -timeout 30m ./internal/store/; \
		status=$$?; docker rm -f toolbox-ch-bench >/dev/null; exit $$status

vet:
	go vet ./...

lint: vet
	golangci-lint run ./...

docker:
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(VERSION) .

helm-lint:
	helm lint $(CHART)
	helm lint $(CHART) --set clickhouse.enabled=false --set 'externalClickhouse.addr[0]=ch:9000'

helm-template:
	helm template toolbox $(CHART) --namespace toolbox

# Creates a kind cluster wired for audit, installs the chart and asserts on
# real writes. KEEP=1 leaves the cluster up.
e2e:
	./hack/kind/e2e.sh

clean:
	rm -rf bin hack/kind/.work
