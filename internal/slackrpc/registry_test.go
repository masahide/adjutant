package slackrpc

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
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
	if err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	statuses := registry.ListStatuses()
	if len(statuses) != 1 {
		t.Fatalf("len(statuses) = %d, want 1", len(statuses))
	}
	if statuses[0].Ready {
		t.Fatalf("status ready = %v, want false", statuses[0].Ready)
	}
}

func TestWorkspaceRegistryInitSequentialEmptyAllowed(t *testing.T) {
	registry := NewWorkspaceRegistry()
	if err := registry.InitSequential(context.Background(), []WorkspaceConfig{}, func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{WorkspaceKey: cfg.WorkspaceKey, Ready: true}, nil
	}); err != nil {
		t.Fatalf("InitSequential returned error: %v", err)
	}

	statuses := registry.ListStatuses()
	if len(statuses) != 0 {
		t.Fatalf("len(statuses) = %d, want 0", len(statuses))
	}
}

func TestWorkspaceRegistryRegisterAndUnregister(t *testing.T) {
	registry := NewWorkspaceRegistry()
	initializer := func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return &WorkspaceRuntime{
			WorkspaceKey: cfg.WorkspaceKey,
			Ready:        true,
		}, nil
	}

	runtime, err := registry.Register(context.Background(), WorkspaceConfig{
		WorkspaceKey: "acme",
		XOXC:         "xoxc",
		XOXD:         "xoxd",
	}, initializer)
	if err != nil {
		t.Fatalf("Register returned error: %v", err)
	}
	if runtime.WorkspaceKey != "acme" {
		t.Fatalf("runtime.WorkspaceKey = %q, want acme", runtime.WorkspaceKey)
	}

	if _, err := registry.Register(context.Background(), WorkspaceConfig{
		WorkspaceKey: "acme",
		XOXC:         "xoxc",
		XOXD:         "xoxd",
	}, initializer); !errors.Is(err, ErrWorkspaceAlreadyExists) {
		t.Fatalf("Register duplicate error = %v, want ErrWorkspaceAlreadyExists", err)
	}

	removed, err := registry.Unregister("acme")
	if err != nil {
		t.Fatalf("Unregister returned error: %v", err)
	}
	if removed.WorkspaceKey != "acme" {
		t.Fatalf("removed.WorkspaceKey = %q, want acme", removed.WorkspaceKey)
	}

	if _, err := registry.Unregister("acme"); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("Unregister missing error = %v, want ErrWorkspaceNotFound", err)
	}
}

func TestWorkspaceRegistryRegisterValidation(t *testing.T) {
	registry := NewWorkspaceRegistry()
	initializer := func(_ context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error) {
		return nil, fmt.Errorf("unexpected initializer call: %s", cfg.WorkspaceKey)
	}

	_, err := registry.Register(context.Background(), WorkspaceConfig{
		WorkspaceKey: "",
		XOXC:         "xoxc",
		XOXD:         "xoxd",
	}, initializer)
	if err == nil || !strings.Contains(err.Error(), "workspace_key is required") {
		t.Fatalf("Register error = %v, want workspace_key validation error", err)
	}
}
