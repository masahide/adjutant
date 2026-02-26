package slackrpc

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestWorkspaceRegistryInitSequential(t *testing.T) {
	registry := NewWorkspaceRegistry()
	order := make([]string, 0)

	configs := []WorkspaceConfig{
		{WorkspaceKey: "alpha", XOXC: "xoxc-1", XOXD: "xoxd-1"},
		{WorkspaceKey: "beta", XOXC: "xoxc-2", XOXD: "xoxd-2"},
		{WorkspaceKey: "gamma", XOXC: "xoxc-3", XOXD: "xoxd-3"},
	}

	err := registry.InitSequential(context.Background(), configs, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		order = append(order, cfg.WorkspaceKey)
		if cfg.WorkspaceKey == "beta" {
			return nil, errors.New("simulated failure")
		}
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
	})
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	if !reflect.DeepEqual(order, []string{"alpha", "beta", "gamma"}) {
		t.Fatalf("initializer order = %v, want [alpha beta gamma]", order)
	}

	statuses := registry.ListStatuses()
	if len(statuses) != 3 {
		t.Fatalf("len(statuses) = %d, want 3", len(statuses))
	}

	if statuses[0].WorkspaceKey != "alpha" || !statuses[0].Ready {
		t.Fatalf("alpha status unexpected: %+v", statuses[0])
	}
	if statuses[1].WorkspaceKey != "beta" || statuses[1].Ready {
		t.Fatalf("beta status unexpected: %+v", statuses[1])
	}
	if statuses[1].InitError == "" {
		t.Fatalf("beta init error must not be empty")
	}

	resolved, err := registry.ResolveWorkspaceKey("")
	if err != nil {
		t.Fatalf("ResolveWorkspaceKey default returned error: %v", err)
	}
	if resolved != "alpha" {
		t.Fatalf("default workspace key = %q, want alpha", resolved)
	}
}

func TestWorkspaceRegistryInitSequentialAllFailed(t *testing.T) {
	registry := NewWorkspaceRegistry()
	configs := []WorkspaceConfig{{WorkspaceKey: "alpha", XOXC: "x", XOXD: "d"}}

	err := registry.InitSequential(context.Background(), configs, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return nil, errors.New("always fail")
	})
	if err == nil {
		t.Fatal("expected error when all workspaces fail")
	}
}
