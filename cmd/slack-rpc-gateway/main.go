package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cyg-infra/adjutant/internal/slackrpc"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func main() {
	var (
		configPath string
		listenAddr string
	)

	flag.StringVar(&configPath, "config", "./config/slack-rpc-gateway.yaml", "Path to gateway config file (yaml/json)")
	flag.StringVar(&listenAddr, "listen", "", "Listen address override (e.g. :8080)")
	flag.Parse()

	cfg, err := slackrpc.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
		os.Exit(1)
	}
	if listenAddr != "" {
		cfg.Listen = listenAddr
	}

	logger, err := newLogger(cfg.LogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		_ = logger.Sync()
	}()

	registry := slackrpc.NewWorkspaceRegistry()
	envBootstrapper := slackrpc.NewEnvBootstrapper()
	initializer := slackrpc.BuildWorkspaceInitializer(logger, envBootstrapper)

	logger.Info("initializing workspace providers sequentially", zap.Int("workspace_count", len(cfg.Workspaces)))
	if err := registry.InitSequential(context.Background(), cfg.Workspaces, initializer); err != nil {
		logger.Error("workspace initialization failed", zap.Error(err))
		os.Exit(1)
	}

	handler := slackrpc.NewHTTPHandler(registry, logger, initializer)
	httpServer := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("slack rpc gateway is listening", zap.String("listen", cfg.Listen))
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && serveErr != http.ErrServerClosed {
			logger.Fatal("http server failed", zap.Error(serveErr))
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown failed", zap.Error(err))
		os.Exit(1)
	}

	logger.Info("slack rpc gateway stopped")
}

func newLogger(level string) (*zap.Logger, error) {
	atomicLevel := zap.NewAtomicLevelAt(zap.InfoLevel)
	if level != "" {
		if err := atomicLevel.UnmarshalText([]byte(level)); err != nil {
			return nil, fmt.Errorf("invalid log level %q: %w", level, err)
		}
	}

	config := zap.Config{
		Level:            atomicLevel,
		Development:      false,
		Encoding:         "json",
		EncoderConfig:    zap.NewProductionEncoderConfig(),
		OutputPaths:      []string{"stdout"},
		ErrorOutputPaths: []string{"stderr"},
	}
	config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	return config.Build()
}
