package slackrpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/korotovsky/slack-mcp-server/pkg/provider"
	"github.com/mark3labs/mcp-go/mcp"
	"go.uber.org/zap"
)

func TestHealthz(t *testing.T) {
	registry := NewWorkspaceRegistry()
	err := registry.InitSequential(context.Background(), []WorkspaceConfig{
		{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"},
		{WorkspaceKey: "beta", XOXC: "x2", XOXD: "d2"},
	}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		ready := cfg.WorkspaceKey == "alpha"
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: ready}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	handler := NewHTTPHandler(registry, zap.NewNop(), nil)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal healthz response: %v", err)
	}
	if ok, _ := payload["ok"].(bool); !ok {
		t.Fatalf("ok = %v, want true", payload["ok"])
	}
}

func TestHandleWorkspacesList(t *testing.T) {
	registry := NewWorkspaceRegistry()
	err := registry.InitSequential(context.Background(), []WorkspaceConfig{{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"}}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	gateway := &GatewayMCP{registry: registry, logger: zap.NewNop()}
	result, callErr := gateway.handleWorkspacesList(context.Background(), mcp.CallToolRequest{})
	if callErr != nil {
		t.Fatalf("handleWorkspacesList returned error: %v", callErr)
	}
	if result == nil {
		t.Fatal("result is nil")
	}
	if len(result.Content) == 0 {
		t.Fatal("result content is empty")
	}
}

func TestResolveRuntimeNotFound(t *testing.T) {
	registry := NewWorkspaceRegistry()
	err := registry.InitSequential(context.Background(), []WorkspaceConfig{{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"}}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	gateway := &GatewayMCP{registry: registry, logger: zap.NewNop()}
	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      "users_list",
			Arguments: map[string]any{"workspace_key": "missing"},
		},
	}

	runtime, toolErr := gateway.resolveRuntime(req)
	if runtime != nil {
		t.Fatal("runtime must be nil for unknown workspace")
	}
	if toolErr == nil || !toolErr.IsError {
		t.Fatal("tool error must be returned for unknown workspace")
	}
}

func TestResolveRuntimeRequiresWorkspaceKey(t *testing.T) {
	registry := NewWorkspaceRegistry()
	err := registry.InitSequential(context.Background(), []WorkspaceConfig{{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"}}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{
			WorkspaceKey: cfg.WorkspaceKey,
			Ready:        true,
			Provider:     &provider.ApiProvider{},
		}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	gateway := &GatewayMCP{registry: registry, logger: zap.NewNop()}
	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      "users_list",
			Arguments: map[string]any{},
		},
	}

	runtime, toolErr := gateway.resolveRuntime(req)
	if runtime != nil {
		t.Fatal("runtime must be nil when workspace_key is missing")
	}
	if toolErr == nil || !toolErr.IsError {
		t.Fatal("tool error must be returned when workspace_key is missing")
	}
}

func TestHandleAuthTest(t *testing.T) {
	registry := NewWorkspaceRegistry()
	err := registry.InitSequential(context.Background(), []WorkspaceConfig{{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"}}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{
			WorkspaceKey: cfg.WorkspaceKey,
			Ready:        true,
			Provider:     &provider.ApiProvider{},
			TeamID:       "TALPHA",
			EnterpriseID: "EALPHA",
			WorkspaceURL: "https://alpha.slack.test/",
			AuthTest: &AuthTestIdentity{
				URL:          "https://alpha.slack.test/",
				Team:         "Alpha",
				User:         "tester",
				TeamID:       "TALPHA",
				UserID:       "UALPHA",
				EnterpriseID: "EALPHA",
			},
		}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	gateway := &GatewayMCP{registry: registry, logger: zap.NewNop()}
	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      "auth_test",
			Arguments: map[string]any{"workspace_key": "alpha"},
		},
	}

	result, callErr := gateway.handleAuthTest(context.Background(), req)
	if callErr != nil {
		t.Fatalf("handleAuthTest returned error: %v", callErr)
	}
	if result == nil {
		t.Fatal("result must not be nil")
	}
	if result.IsError {
		t.Fatalf("result must not be error: %+v", result)
	}

	payload, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content must be map, got %T", result.StructuredContent)
	}
	if payload["workspace_key"] != "alpha" {
		t.Fatalf("workspace_key = %v, want alpha", payload["workspace_key"])
	}
	if payload["team_id"] != "TALPHA" {
		t.Fatalf("team_id = %v, want TALPHA", payload["team_id"])
	}
	if payload["user_id"] != "UALPHA" {
		t.Fatalf("user_id = %v, want UALPHA", payload["user_id"])
	}
}

func TestClassifyError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", err: nil, want: "api_error"},
		{name: "invalid_auth", err: errors.New("invalid_auth"), want: "auth_invalid"},
		{name: "rate_limited", err: errors.New("rate_limited"), want: "rate_limited"},
		{name: "not_found", err: errors.New("resource not found"), want: "not_found"},
	}

	for _, tc := range cases {
		got := classifyError(tc.err)
		if got != tc.want {
			t.Fatalf("%s classifyError() = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestHandleWorkspaceRegisterAndUnregister(t *testing.T) {
	registry := NewWorkspaceRegistry()
	gateway := &GatewayMCP{
		registry: registry,
		logger:   zap.NewNop(),
		initializer: func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
			return &WorkspaceRuntime{
				WorkspaceKey: cfg.WorkspaceKey,
				Ready:        true,
				AuthTest: &AuthTestIdentity{
					URL:          "https://acme.slack.test/",
					Team:         "Acme",
					User:         "bot",
					TeamID:       "TACME",
					UserID:       "UACME",
					EnterpriseID: "EACME",
					BotID:        "BACME",
				},
			}, nil
		},
	}

	registerReq := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "workspace_register",
			Arguments: map[string]any{
				"workspace_key": "acme",
				"xoxc":          "xoxc-token",
				"xoxd":          "xoxd-token",
			},
		},
	}
	registerResult, err := gateway.handleWorkspaceRegister(context.Background(), registerReq)
	if err != nil {
		t.Fatalf("handleWorkspaceRegister returned error: %v", err)
	}
	if registerResult == nil || registerResult.IsError {
		t.Fatalf("register result must be non-error, got: %+v", registerResult)
	}
	registerPayload, ok := registerResult.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("register structured content must be map, got %T", registerResult.StructuredContent)
	}
	authTest, ok := registerPayload["auth_test"].(map[string]any)
	if !ok {
		t.Fatalf("auth_test must be map, got %T", registerPayload["auth_test"])
	}
	if authTest["team_id"] != "TACME" {
		t.Fatalf("auth_test.team_id = %v, want TACME", authTest["team_id"])
	}
	if statuses := registry.ListStatuses(); len(statuses) != 1 {
		t.Fatalf("len(statuses) = %d, want 1", len(statuses))
	}

	unregisterReq := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "workspace_unregister",
			Arguments: map[string]any{
				"workspace_key": "acme",
			},
		},
	}
	unregisterResult, err := gateway.handleWorkspaceUnregister(context.Background(), unregisterReq)
	if err != nil {
		t.Fatalf("handleWorkspaceUnregister returned error: %v", err)
	}
	if unregisterResult == nil || unregisterResult.IsError {
		t.Fatalf("unregister result must be non-error, got: %+v", unregisterResult)
	}
	if statuses := registry.ListStatuses(); len(statuses) != 0 {
		t.Fatalf("len(statuses) = %d, want 0", len(statuses))
	}
}

func TestHandleWorkspaceRegisterDuplicate(t *testing.T) {
	registry := NewWorkspaceRegistry()
	if _, err := registry.Register(context.Background(), WorkspaceConfig{
		WorkspaceKey: "acme",
		XOXC:         "xoxc-token",
		XOXD:         "xoxd-token",
	}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
	}); err != nil {
		t.Fatalf("Register setup returned error: %v", err)
	}

	gateway := &GatewayMCP{
		registry: registry,
		logger:   zap.NewNop(),
		initializer: func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
			return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
		},
	}

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "workspace_register",
			Arguments: map[string]any{
				"workspace_key": "acme",
				"xoxc":          "xoxc-token",
				"xoxd":          "xoxd-token",
			},
		},
	}
	result, err := gateway.handleWorkspaceRegister(context.Background(), req)
	if err != nil {
		t.Fatalf("handleWorkspaceRegister returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("duplicate register must return tool error, got: %+v", result)
	}
	if statuses := registry.ListStatuses(); len(statuses) != 1 {
		t.Fatalf("len(statuses) = %d, want 1", len(statuses))
	}
}

func TestHandleWorkspaceRegisterWithoutWorkspaceKey(t *testing.T) {
	registry := NewWorkspaceRegistry()
	gateway := &GatewayMCP{
		registry: registry,
		logger:   zap.NewNop(),
		initializer: func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
			_ = cfg.WorkspaceKey
			return &WorkspaceRuntime{
				WorkspaceKey: "",
				Ready:        true,
				TeamID:       "T-AUTO",
				EnterpriseID: "E-AUTO",
				WorkspaceURL: "https://auto.slack.com/",
			}, nil
		},
	}

	req := mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name: "workspace_register",
			Arguments: map[string]any{
				"xoxc": "xoxc-token",
				"xoxd": "xoxd-token",
			},
		},
	}
	result, err := gateway.handleWorkspaceRegister(context.Background(), req)
	if err != nil {
		t.Fatalf("handleWorkspaceRegister returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("register result must be non-error, got: %+v", result)
	}

	statuses := registry.ListStatuses()
	if len(statuses) != 1 {
		t.Fatalf("len(statuses) = %d, want 1", len(statuses))
	}
	if statuses[0].WorkspaceKey != "E-AUTO" {
		t.Fatalf("workspace_key = %q, want E-AUTO", statuses[0].WorkspaceKey)
	}
}
