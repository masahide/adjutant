# syntax=docker/dockerfile:1.7

FROM golang:1.24-bookworm AS builder
WORKDIR /src
ENV GOFLAGS=-mod=mod

COPY go.mod go.sum ./
COPY vendor/slack-mcp-server ./vendor/slack-mcp-server
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY config/slack-rpc-gateway.example.yaml ./config/slack-rpc-gateway.example.yaml

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w' -o /out/slack-rpc-gateway ./cmd/slack-rpc-gateway

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app

COPY --from=builder /out/slack-rpc-gateway /app/slack-rpc-gateway
COPY --from=builder /src/config/slack-rpc-gateway.example.yaml /app/config/slack-rpc-gateway.yaml

EXPOSE 8080
ENTRYPOINT ["/app/slack-rpc-gateway"]
CMD ["--config", "/app/config/slack-rpc-gateway.yaml", "--listen", ":8080"]
