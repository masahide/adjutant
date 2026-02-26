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

			if isDemoWorkspace {
				logger.Info("demo workspace detected")
			}

			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("initialize workspace %s: %w", workspaceKey, err)
		}

		workspaceURL := ""
		teamID := ""
		enterpriseID := ""
		var authTest *AuthTestIdentity
		if isDemoWorkspace {
			workspaceURL = "https://_.slack.com"
			teamID = "TEAM123456"
			authTest = &AuthTestIdentity{
				URL:    workspaceURL,
				Team:   "Demo Team",
				User:   "Username",
				TeamID: teamID,
				UserID: "U1234567890",
			}
		} else if slackClient, ok := apiProvider.Slack().(*provider.MCPSlackClient); ok && slackClient != nil {
			// Avoid extra API requests here. provider.New already initializes and keeps auth response.
			if authResp := slackClient.AuthResponse(); authResp != nil {
				workspaceURL = authResp.URL
				teamID = authResp.TeamID
				enterpriseID = authResp.EnterpriseID
				authTest = &AuthTestIdentity{
					URL:          authResp.URL,
					Team:         authResp.Team,
					User:         authResp.User,
					TeamID:       authResp.TeamID,
					UserID:       authResp.UserID,
					EnterpriseID: authResp.EnterpriseID,
					BotID:        authResp.BotID,
				}
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
			AuthTest:          authTest,
			InitializedAtUnix: time.Now().Unix(),
		}

		return runtime, nil
	}
}
