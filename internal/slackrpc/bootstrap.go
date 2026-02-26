package slackrpc

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/korotovsky/slack-mcp-server/pkg/handler"
	"github.com/korotovsky/slack-mcp-server/pkg/provider"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func BuildWorkspaceInitializer(baseLogger *zap.Logger, envBootstrapper *EnvBootstrapper) WorkspaceInitializer {
	return func(ctx context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		workspaceKey := strings.TrimSpace(cfg.WorkspaceKey)
		if workspaceKey == "" {
			return nil, fmt.Errorf("workspace_key is required")
		}
		isDemoWorkspace := strings.TrimSpace(cfg.XOXC) == "demo" && strings.TrimSpace(cfg.XOXD) == "demo"

		logger := baseLogger.With(zap.String("workspace_key", workspaceKey))
		var apiProvider *provider.ApiProvider

		err := envBootstrapper.WithWorkspaceEnv(cfg, func() (innerErr error) {
			defer func() {
				if recovered := recover(); recovered != nil {
					innerErr = fmt.Errorf("provider.New panic: %v", recovered)
				}
			}()

			providerLogger := logger.WithOptions(zap.WithFatalHook(zapcore.WriteThenPanic))
			apiProvider = provider.New("http", providerLogger)
			if apiProvider == nil {
				return fmt.Errorf("provider.New returned nil")
			}

			if !isDemoWorkspace {
				initCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
				defer cancel()

				if err := apiProvider.RefreshUsers(initCtx); err != nil {
					return fmt.Errorf("refresh users: %w", err)
				}
				if err := apiProvider.RefreshChannels(initCtx); err != nil {
					return fmt.Errorf("refresh channels: %w", err)
				}
			} else {
				logger.Info("demo workspace detected; skipping cache warmup")
			}

			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("initialize workspace %s: %w", workspaceKey, err)
		}

		ready := true
		if !isDemoWorkspace {
			var readyErr error
			ready, readyErr = apiProvider.IsReady()
			if readyErr != nil {
				return nil, fmt.Errorf("workspace %s readiness check failed: %w", workspaceKey, readyErr)
			}
			if !ready {
				return nil, fmt.Errorf("workspace %s is not ready", workspaceKey)
			}
		}

		workspaceURL := ""
		teamID := ""
		enterpriseID := ""
		if isDemoWorkspace {
			workspaceURL = "https://_.slack.com"
			teamID = "TEAM123456"
		} else {
			authResp, authErr := apiProvider.Slack().AuthTest()
			if authErr != nil {
				logger.Warn("auth_test failed after provider init", zap.Error(authErr))
			} else {
				workspaceURL = authResp.URL
				teamID = authResp.TeamID
				enterpriseID = authResp.EnterpriseID
			}
		}

		runtime := &WorkspaceRuntime{
			WorkspaceKey:      workspaceKey,
			Provider:          apiProvider,
			Conversations:     handler.NewConversationsHandler(apiProvider, logger),
			Channels:          handler.NewChannelsHandler(apiProvider, logger),
			Ready:             true,
			TeamID:            teamID,
			EnterpriseID:      enterpriseID,
			WorkspaceURL:      workspaceURL,
			InitializedAtUnix: time.Now().Unix(),
		}

		return runtime, nil
	}
}
