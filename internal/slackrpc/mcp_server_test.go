package slackrpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

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

	handler := NewHTTPHandler(registry, zap.NewNop())
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
