package slackrpc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigYAML(t *testing.T) {
	tempDir := t.TempDir()
	path := filepath.Join(tempDir, "slack-rpc-gateway.yaml")
	content := []byte(`listen: ":18080"
log_level: "debug"
workspaces:
  - workspace_key: "acme"
    xoxc: "xoxc-token"
    xoxd: "xoxd-token"
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.Listen != ":18080" {
		t.Fatalf("Listen = %q, want :18080", cfg.Listen)
	}
	if cfg.LogLevel != "debug" {
		t.Fatalf("LogLevel = %q, want debug", cfg.LogLevel)
	}
	if len(cfg.Workspaces) != 1 {
		t.Fatalf("len(Workspaces) = %d, want 1", len(cfg.Workspaces))
	}
	if cfg.Workspaces[0].WorkspaceKey != "acme" {
		t.Fatalf("WorkspaceKey = %q, want acme", cfg.Workspaces[0].WorkspaceKey)
	}
}

func TestLoadConfigValidation(t *testing.T) {
	tempDir := t.TempDir()
	path := filepath.Join(tempDir, "bad.json")
	content := []byte(`{"workspaces":[{"workspace_key":"","xoxc":"x","xoxd":"d"}]}`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write bad config file: %v", err)
	}

	if _, err := LoadConfig(path); err == nil {
		t.Fatal("LoadConfig expected validation error, got nil")
	}
}

func TestLoadConfigAllowsEmptyWorkspaces(t *testing.T) {
	tempDir := t.TempDir()
	path := filepath.Join(tempDir, "empty.yaml")
	content := []byte(`listen: ":8080"
log_level: "info"
workspaces: []
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if len(cfg.Workspaces) != 0 {
		t.Fatalf("len(Workspaces) = %d, want 0", len(cfg.Workspaces))
	}
}
