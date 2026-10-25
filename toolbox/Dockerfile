# syntax=docker/dockerfile:1
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/toolbox ./cmd/toolbox

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/toolbox /toolbox
USER 65532:65532
EXPOSE 8080 9443
ENTRYPOINT ["/toolbox"]
